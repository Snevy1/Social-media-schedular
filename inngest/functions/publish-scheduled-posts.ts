import { getInsforgeAdminClient } from "@/lib/insforge-server";
import { inngest } from "../client";
import { ImageObject, PostType } from "@/types/post.type";
import { decrypt, encrypt } from "@/lib/encryption";
import { refreshOauthToken } from "@/lib/social-oauth";
import { ChannelTypeEnum } from "@/constants/channels";
import { NonRetriableError } from "inngest";

type DuePost = {
    id: string
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL!

export const publishScheduledPostsCron = inngest.createFunction(
    {
        id: "publish-scheduled-posts-cron",
        name: "Publish Scheduled Posts",
        triggers: [
            {
                cron: "*/10 * * * *"
            }
        ]
    },
    async ({ step, logger }) => {

        const duePosts = await step.run("load-due-scheduled-posts", async () => {
            const insforge = getInsforgeAdminClient()
            const now = new Date().toISOString()
            const { data, error } = await insforge.database
                .from("scheduled_posts")
                .select("id, status, scheduled_at")
                .eq("status", "queue")
                .lte("scheduled_at", now)
                .order("scheduled_at", { ascending: true })

            logger.info("Load due scheduled posts", { count: data?.length })

            if (error) {
                logger.error(error)
                throw error
            }
            return (data ?? []) as DuePost[]
        })

        if (duePosts.length === 0) {
            return { queued: 0 }
        }
        logger.info("Send out the post for publish", { count: duePosts.length })

        await step.sendEvent(
            "send-out-post-for-publish",
            duePosts.map(post => ({
                name: "post/publish.requested",
                data: {
                    postId: post.id
                }
            }))
        )

        return { message: "sent out posts for publishing", queued: duePosts.length }
    }
)

export const publishScheduledPost = inngest.createFunction(
    {
        id: "publish-scheduled-post",
        name: "Publish Scheduled Post",
        triggers: {
            event: "post/publish.requested"
        }
    },
    async ({ event, step, logger }) => {
        const post = await step.run("load-post", async () => {
            const insforge = getInsforgeAdminClient()
            const { data, error } = await insforge.database
                .from("scheduled_posts")
                .select("*, user_channels(*, channel_types(id, type, name))")
                .eq("id", event.data.postId)
                .eq("status", "queue")
                .single()

            logger.info("Load post", { data })
            if (error) {
                logger.error(error)
                throw error
            }

            return data as PostType;
        })

        if (!post) {
            logger.error("Post not found", { postId: event.data.postId })
            return { skipped: true, reason: "post_not_found" }
        }

        const userChannel = post.user_channels
        if (!userChannel) return { skipped: true, reason: "user_channel_not_found" }

        const channelType = userChannel.channel_types
        if (!channelType) return { skipped: true, reason: "channel_type_not_found" }

        const providerType = post.user_channels?.channel_types?.type;
        const accessToken = decrypt(post.user_channels?.access_token)
        const refreshToken = decrypt(post.user_channels?.refresh_token);
        const tokenExpiresAt = post.user_channels?.token_expires_at ?
            new Date(post.user_channels.token_expires_at).getTime() : null;
        const callbackUrl = `${APP_URL}/api/channel/callback`;
        const shouldRefreshBeforePublish = Boolean(refreshToken) &&
            tokenExpiresAt !== null &&
            tokenExpiresAt <= Date.now()

        if (!providerType || !accessToken) {
            logger.error("Missing provider type or access token", { providerType, accessToken })
            return { skipped: true, reason: "missing_provider_or_token" }
        }

        let currentAccessToken = accessToken;

        if (shouldRefreshBeforePublish && refreshToken) {
            const result = await step.run("refresh-token", async () => {
                const data = await refreshOauthToken(
                    providerType as ChannelTypeEnum,
                    refreshToken,
                    callbackUrl
                )
                await saveRefreshedToken(
                    post.user_channels?.id,
                    data.accessToken,
                    data.refreshToken ?? refreshToken,
                    data.expiresAt
                )
                return data;
            })
            currentAccessToken = result.accessToken;
        }

        let publishedUrl: string | null = null

        try {
            publishedUrl = await step.run("publish-to-provider", async () => {
                if (providerType === ChannelTypeEnum.TWITTER) {
                    return publishToTwitter({
                        accessToken: currentAccessToken,
                        content: post.content,
                        handle: post.user_channels?.handle,
                        images: post.images,
                        logger
                    });
                }

                if (providerType === ChannelTypeEnum.LINKEDIN) {
                    return publishToLinkedIn({
                        accessToken: currentAccessToken,
                        text: post.content,
                        authorId: post.user_channels?.provider_account_id,
                        images: post.images,
                        logger
                    });
                }

                if (providerType === ChannelTypeEnum.INSTAGRAM) {
                    return publishToInstagram({
                        accessToken: currentAccessToken,
                        caption: post.content,
                        igUserId: post.user_channels?.provider_account_id,
                        images: post.images,
                        logger
                    });
                }

                if (providerType === ChannelTypeEnum.TIKTOK) {
                    return publishToTikTok({
                        accessToken: currentAccessToken,
                        caption: post.content,
                        images: post.images,
                        logger
                    });
                }

                throw new NonRetriableError(`Unsupported provider type: ${providerType}`)
            })

            await step.run("mark-post-published", async () => {
                await markPostPublished(post.id, publishedUrl);
            })

            return { published: true, provider: providerType }
        } catch (error) {
            logger.error("Failed to publish post", { error })
            const message = error instanceof Error ? error.message : "Unknown error"
            await markPostFailed(post.id, message)
            throw error
        }
    }
)


// ─────────────────────────────────────────────
// TWITTER
// ─────────────────────────────────────────────

async function publishToTwitter({
    accessToken,
    content,
    handle,
    images,
    logger
}: {
    accessToken: string;
    content: string;
    handle?: string | null;
    images?: ImageObject[]
    logger: any;
}) {
    const mediaIds = images?.length ?
        await uploadImagesToTwitter({
            accessToken,
            images,
            logger
        }) : [];

    const response = await fetch("https://api.x.com/2/tweets", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            text: content,
            ...(mediaIds.length > 0 ? {
                media: {
                    media_ids: mediaIds
                }
            } : {})
        })
    })

    const responseText = await response.text()
    let data: any = null;
    try {
        data = JSON.parse(responseText)
    } catch (error) {
        logger.error("Failed to parse Twitter response", { error, responseText })
        data = null
    }

    if (!response.ok) {
        logger.error("Twitter API error", {
            status: response.status,
            statusText: response.statusText,
            body: data ?? responseText
        })
        const message = `Failed to publish to Twitter: ${response.status} - ${data?.detail || data?.title || responseText}`
        // Don't retry billing/auth errors
        if (response.status === 402 || response.status === 401 || response.status === 403) {
            throw new NonRetriableError(message)
        }
        throw new Error(message)
    }

    const postId = data?.data?.id;
    if (!postId) throw new Error("Failed to get post ID from Twitter response")

    return handle ? `https://x.com/${handle}/status/${postId}` : null;
}


async function uploadImagesToTwitter({
    accessToken,
    images,
    logger
}: {
    accessToken: string;
    images: ImageObject[];
    logger: any;
}) {
    const mediaIds: string[] = [];

    for (const image of images) {
        const fileResponse = await fetch(image.url);
        if (!fileResponse.ok) throw new Error("Failed to fetch image");

        const bytes = await fileResponse.arrayBuffer();
        const contentType = fileResponse.headers.get("content-type")?.split(";")[0].trim();

        const pathname = new URL(image.url).pathname.toLowerCase();

        const mediaType =
            contentType &&
                contentType != "binary/octet-stream" &&
                contentType != "application/octet-stream" ? contentType :
                pathname.endsWith(".png") ? "image/png" :
                    pathname.endsWith(".webp") ? "image/webp" :
                        "image/jpeg"

        const formData = new FormData();
        const blob = new Blob([bytes], { type: mediaType });
        formData.append("media", blob);
        formData.append("media_category", "tweet_image");
        formData.append("media_type", mediaType);

        const uploadRes = await fetch("https://api.x.com/2/media/upload", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`
            },
            body: formData
        })

        const response = await uploadRes.text();
        logger.info("Twitter media upload response", { response });
        let data: any = null;
        try {
            data = JSON.parse(response);
        } catch (e) {
            logger.error("Failed to parse Twitter media upload response", { response });
            data = null
        }

        if (!uploadRes.ok) {
            throw new Error(`Failed to upload media to Twitter: ${response}`)
        }

        const mediaId = data?.data?.id || data?.data?.media_key
        if (!mediaId) throw new Error("Failed to get media ID from Twitter response")
        mediaIds.push(mediaId)
    }
    return mediaIds
}


// ─────────────────────────────────────────────
// LINKEDIN
// ─────────────────────────────────────────────

async function publishToLinkedIn({
    accessToken,
    text,
    authorId,
    images,
    logger,
}: {
    accessToken: string
    text: string
    authorId?: string | null
    images?: { url: string; key: string }[]
    logger: any
}) {
    if (!authorId) throw new NonRetriableError("Missing LinkedIn provider account id.")

    const imageUrn = images?.[0]?.url
        ? await uploadLinkedInImage({
            accessToken,
            authorId,
            imageUrl: images[0].url,
        })
        : null

    const body: Record<string, unknown> = {
        author: `urn:li:person:${authorId}`,
        commentary: text,
        visibility: "PUBLIC",
        distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
    }

    if (imageUrn) {
        body.content = {
            media: {
                id: imageUrn,
            },
        }
    }

    const response = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            "Linkedin-Version": "202604",
        },
        body: JSON.stringify(body),
    })

    const responseText = await response.text()
    let data: any = null
    try {
        data = responseText ? JSON.parse(responseText) : null
    } catch {
        logger.error("Failed to parse LinkedIn response", { responseText })
    }

    if (!response.ok) {
        const message = data?.message || "Failed to publish to LinkedIn."
        if (response.status === 401 || response.status === 403) {
            throw new NonRetriableError(message)
        }
        throw new Error(message)
    }

    const restliId = response.headers.get("x-restli-id") || data?.id || null
    return restliId ? `https://www.linkedin.com/feed/update/${encodeURIComponent(restliId)}` : null
}


async function uploadLinkedInImage({
    accessToken,
    authorId,
    imageUrl,
}: {
    accessToken: string
    authorId: string
    imageUrl: string
}) {
    const initResponse = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            "Linkedin-Version": "202604",
        },
        body: JSON.stringify({
            initializeUploadRequest: {
                owner: `urn:li:person:${authorId}`,
            },
        }),
    })

    const initResponseText = await initResponse.text()
    let initData: { message?: string; value?: { uploadUrl?: string; image?: string } } | null = null
    try {
        initData = initResponseText ? JSON.parse(initResponseText) : null
    } catch {
        throw new Error("Failed to parse LinkedIn image initialization response.")
    }

    if (!initResponse.ok) {
        throw new Error(initData?.message || "Failed to initialize LinkedIn image upload.")
    }

    const uploadUrl = initData?.value?.uploadUrl
    const imageUrn = initData?.value?.image
    if (!uploadUrl || !imageUrn) {
        throw new Error("LinkedIn image upload initialization did not return an upload URL.")
    }

    const imageResponse = await fetch(imageUrl)
    if (!imageResponse.ok) throw new Error("Failed to fetch image for LinkedIn upload.")

    const contentType = imageResponse.headers.get("content-type") || "image/jpeg"
    const imageBuffer = await imageResponse.arrayBuffer()

    const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: imageBuffer,
    })

    if (!uploadResponse.ok) throw new Error("Failed to upload image to LinkedIn.")

    return imageUrn as string
}


// ─────────────────────────────────────────────
// INSTAGRAM (Meta Graph API)
// Requires: Instagram Business/Creator account
// Scopes: instagram_basic, instagram_content_publish
// ─────────────────────────────────────────────

async function publishToInstagram({
    accessToken,
    caption,
    igUserId,
    images,
    logger,
}: {
    accessToken: string
    caption: string
    igUserId?: string | null
    images?: ImageObject[]
    logger: any
}) {
    if (!igUserId) throw new NonRetriableError("Missing Instagram user ID.")

    const imageUrl = images?.[0]?.url ?? null

    if (!imageUrl) {
        throw new NonRetriableError(
            "Instagram requires at least one image. Text-only posts are not supported."
        )
    }

    // Step 1: Create media container
    const containerRes = await fetch(
        `https://graph.facebook.com/v21.0/${igUserId}/media`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                image_url: imageUrl,
                caption: caption,
                access_token: accessToken,
            }),
        }
    )

    const containerText = await containerRes.text()
    let containerData: any = null
    try {
        containerData = JSON.parse(containerText)
    } catch {
        logger.error("Failed to parse Instagram container response", { containerText })
    }

    if (!containerRes.ok) {
        logger.error("Instagram container creation error", {
            status: containerRes.status,
            body: containerData ?? containerText
        })
        const message = `Instagram container error: ${containerData?.error?.message || containerText}`
        if (containerRes.status === 401 || containerRes.status === 403) {
            throw new NonRetriableError(message)
        }
        throw new Error(message)
    }

    const containerId = containerData?.id
    if (!containerId) throw new Error("Failed to get Instagram container ID.")

    logger.info("Instagram container created", { containerId })

    // Step 2: Poll until container is ready (instead of fixed wait)
    await waitForInstagramContainer({ igUserId, containerId, accessToken, logger })

    // Step 3: Publish
    const publishRes = await fetch(
        `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                creation_id: containerId,
                access_token: accessToken,
            }),
        }
    )

    const publishText = await publishRes.text()
    let publishData: any = null
    try {
        publishData = JSON.parse(publishText)
    } catch {
        logger.error("Failed to parse Instagram publish response", { publishText })
    }

    if (!publishRes.ok) {
        logger.error("Instagram publish error", {
            status: publishRes.status,
            body: publishData ?? publishText
        })
        const message = `Instagram publish error: ${publishData?.error?.message || publishText}`
        if (publishRes.status === 401 || publishRes.status === 403) {
            throw new NonRetriableError(message)
        }
        throw new Error(message)
    }

    const postId = publishData?.id
    logger.info("Instagram post published", { postId })
    return postId ? `https://www.instagram.com/p/${postId}/` : null
}


// Poll Instagram container status instead of blind wait
async function waitForInstagramContainer({
    igUserId,
    containerId,
    accessToken,
    logger,
    maxAttempts = 10,
    intervalMs = 2000,
}: {
    igUserId: string
    containerId: string
    accessToken: string
    logger: any
    maxAttempts?: number
    intervalMs?: number
}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs))

        const statusRes = await fetch(
            `https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${accessToken}`
        )
        const statusData = await statusRes.json() as { status_code?: string }
        logger.info("Instagram container status", { attempt, status: statusData.status_code })

        if (statusData.status_code === "FINISHED") return   // ready to publish
        if (statusData.status_code === "ERROR") {
            throw new Error("Instagram media container failed to process.")
        }
        // IN_PROGRESS or PUBLISHED — keep polling
    }
    throw new Error("Instagram container timed out waiting to be ready.")
}


// ─────────────────────────────────────────────
// TIKTOK (Content Posting API)
// Requires: TikTok Developer App
// Scopes: video.publish, video.upload (for videos)
//         photo.publish (for image/carousel posts)
// ─────────────────────────────────────────────

async function publishToTikTok({
    accessToken,
    caption,
    images,
    logger,
}: {
    accessToken: string
    caption: string
    images?: ImageObject[]
    logger: any
}) {
    const hasImages = images && images.length > 0

    if (hasImages) {
        return publishTikTokPhotoPost({ accessToken, caption, images: images!, logger })
    } else {
        // TikTok does not support text-only posts via API
        throw new NonRetriableError(
            "TikTok requires at least one image or video. Text-only posts are not supported."
        )
    }
}


async function publishTikTokPhotoPost({
    accessToken,
    caption,
    images,
    logger,
}: {
    accessToken: string
    caption: string
    images: ImageObject[]
    logger: any
}) {
    // TikTok photo posts use "PULL_FROM_URL" — TikTok fetches images from your URLs directly.
    // Your image URLs must be publicly accessible.
    const photoUrls = images.map(img => img.url)

    const body = {
        post_info: {
            title: caption.slice(0, 2200), // TikTok caption limit
            privacy_level: "PUBLIC_TO_EVERYONE",
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
            auto_add_music: true,
        },
        source_info: {
            source: "PULL_FROM_URL",
            photo_images: photoUrls,
            photo_cover_index: 0,
        },
        media_type: "PHOTO",
    }

    const response = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(body),
    })

    const responseText = await response.text()
    let data: any = null
    try {
        data = JSON.parse(responseText)
    } catch {
        logger.error("Failed to parse TikTok response", { responseText })
    }

    if (!response.ok || data?.error?.code !== "ok") {
        logger.error("TikTok API error", {
            status: response.status,
            body: data ?? responseText
        })
        const message = `TikTok publish error: ${data?.error?.message || responseText}`
        if (response.status === 401 || response.status === 403) {
            throw new NonRetriableError(message)
        }
        throw new Error(message)
    }

    const publishId = data?.data?.publish_id
    // TikTok doesn't return a post URL immediately — the post is processed async.
    // You can poll /v2/post/publish/status/fetch/ with the publish_id if needed.
    logger.info("TikTok post submitted", { publishId })
    return null // URL not available immediately
}


// ─────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────

async function saveRefreshedToken(
    userChannelId: string | undefined,
    accessToken: string,
    refreshToken: string,
    expiresAt:  string | undefined | null
) {
    if (!userChannelId) throw new Error("User channel ID is missing");
    const insforge = getInsforgeAdminClient();
    const { error } = await insforge.database
        .from("user_channels")
        .update({
            access_token: encrypt(accessToken),
            refresh_token: encrypt(refreshToken),
            token_expires_at: expiresAt ?? null
        })
        .eq("id", userChannelId);

    if (error) throw error
}

async function markPostPublished(postId: string, published_url: string | null) {
    const insforge = getInsforgeAdminClient();
    const { error } = await insforge.database
        .from("scheduled_posts")
        .update({
            status: "published",
            published_at: new Date().toISOString(),
            published_url: published_url
        })
        .eq("id", postId);
    if (error) throw error
}

async function markPostFailed(postId: string, errorMessage: string) {
    const insforge = getInsforgeAdminClient();
    const { error } = await insforge.database
        .from("scheduled_posts")
        .update({
            status: "failed",
            error_message: errorMessage
        })
        .eq("id", postId);

    if (error) throw error
}