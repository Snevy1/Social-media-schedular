import { ChannelTypeEnum } from "@/constants/channels";
import { OAuthConnectionProfile, OAuthProvider, OAuthTokenResponse } from "./types";

function getEnv(key: string) {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is missing.`)
  return value
}

function getConfig(type: ChannelTypeEnum) {
    return {
        authUrl: getEnv(`${type}_AUTH_URL`),
        tokenUrl: getEnv(`${type}_TOKEN_URL`),
        profileUrl: getEnv(`${type}_PROFILE_URL`),
        clientId: getEnv(`${type}_CLIENT_ID`),
        clientSecret: getEnv(`${type}_CLIENT_SECRET`),
        scope: getEnv(`${type}_SCOPES`).split(',').map(s => s.trim()).filter(Boolean),
    }
}

async function requestToken(
    type: ChannelTypeEnum,
    body: URLSearchParams,
) {
    const config = getConfig(type);
    const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
    }

    if (type === ChannelTypeEnum.TWITTER && config.clientSecret) {
        const auth_header = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
        headers.Authorization = `Basic ${auth_header}`
    }

    const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers,
        body,
    })
    const data = await response.json()

    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || `Token exchange failed: ${response.statusText}`)
    }

    return data
}


function createProvider(type: ChannelTypeEnum, opts: { pkce?: boolean } = {}): OAuthProvider {
    return {
        type,
        getAuthorizationUrl: ({ state, redirectUri, codeChallenge, codeChallengeMethod }) => {
            const config = getConfig(type)
            const params = new URLSearchParams({
                client_id: config.clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: config.scope.join(' '),
                state,
            })
            if (opts.pkce && codeChallenge && codeChallengeMethod) {
                params.append('code_challenge', codeChallenge)
                params.append('code_challenge_method', codeChallengeMethod)
            }
            return `${config.authUrl}?${params.toString()}`
        },
        exchangeCodeForToken: async ({ code, redirectUri, codeVerifier }): Promise<OAuthTokenResponse> => {
            const params = new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: getConfig(type).clientId,
            })

            if (!opts.pkce) {
                params.append('client_secret', getConfig(type).clientSecret)
            }
            if (codeVerifier) {
                params.append('code_verifier', codeVerifier)
            }

            const data = await requestToken(type, params)

            const seconds = Number(data.expires_in)
            const expiresAt = seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null

            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? null,
                expiresAt,
            }
        },
        refreshToken: async ({ refreshToken, redirectUri }) => {
            const config = getConfig(type);
            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: config.clientId,
            })

            if (config.clientSecret) {
                params.append('client_secret', config.clientSecret)
            }
            if (redirectUri) {
                params.append('redirect_uri', redirectUri)
            }

            const data = await requestToken(type, params)

            const seconds = Number(data.expires_in)
            const expiresAt = seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null

            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? null,
                expiresAt,
            }
        },
        getProfile: async ({ accessToken }): Promise<OAuthConnectionProfile> => {
            const config = getConfig(type);
            const response = await fetch(config.profileUrl, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                }
            })
            if (!response.ok) {
                throw new Error('Failed to fetch profile')
            }
            const data = await response.json()

            const profileData = data?.data ?? data?.user ?? data
            const providerAccountId = profileData?.id ?? profileData?.sub ?? profileData?.user_id ?? null;
            const handle = profileData?.username ?? profileData?.screen_name ?? profileData?.handle ?? profileData?.name ?? null;
            const profileImage = profileData?.thread_profile_picture ?? profileData?.profile_image_url ?? profileData?.avatar_url ?? profileData?.profile_image ?? profileData?.picture?.data?.url ?? profileData?.picture?.url ?? profileData?.picture ?? null

            console.log(providerAccountId, handle, "providerAccountId")

            return {
                providerAccountId,
                handle,
                profileImage,
            }
        },
    }
}


// ─────────────────────────────────────────────
// INSTAGRAM — custom getProfile
// Needs to traverse: user token → FB pages → IG business account
// ─────────────────────────────────────────────

async function getInstagramProfile(accessToken: string): Promise<OAuthConnectionProfile> {
    // Step 1: Get Facebook pages linked to this user
    const pagesRes = await fetch(
        `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`
    )
    const pagesData = await pagesRes.json()

    console.log("Instagram pages response", JSON.stringify(pagesData, null, 2))

    if (!pagesRes.ok) {
        throw new Error(`Failed to fetch Facebook pages: ${pagesData?.error?.message || pagesRes.statusText}`)
    }

    const page = pagesData?.data?.[0]
    if (!page) {
        throw new Error("No Facebook Page found. Make sure your Instagram account is linked to a Facebook Page.")
    }

    const pageAccessToken: string = page.access_token
    const pageId: string = page.id

    // Step 2: Get Instagram Business Account linked to that page
    const igRes = await fetch(
        `https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`
    )
    const igData = await igRes.json()

    console.log("Instagram business account response", JSON.stringify(igData, null, 2))

    if (!igRes.ok) {
        throw new Error(`Failed to fetch Instagram business account: ${igData?.error?.message || igRes.statusText}`)
    }

    const igAccountId: string = igData?.instagram_business_account?.id
    if (!igAccountId) {
        throw new Error("No Instagram Business Account linked to this Facebook Page. Make sure your Instagram account is set to Business or Creator.")
    }

    // Step 3: Get Instagram profile details using the page token
    const profileRes = await fetch(
        `https://graph.facebook.com/v21.0/${igAccountId}?fields=id,username,profile_picture_url&access_token=${pageAccessToken}`
    )
    const profileData = await profileRes.json()

    console.log("Instagram profile response", JSON.stringify(profileData, null, 2))

    if (!profileRes.ok) {
        throw new Error(`Failed to fetch Instagram profile: ${profileData?.error?.message || profileRes.statusText}`)
    }

    return {
        providerAccountId: igAccountId,
        handle: profileData?.username ?? null,
        profileImage: profileData?.profile_picture_url ?? null,
        pageAccessToken,  // stored instead of the user token in callback
    }
}


// ─────────────────────────────────────────────
// TIKTOK — custom getProfile
// TikTok returns data nested under data.user
// and needs specific fields param in the request
// ─────────────────────────────────────────────

async function getTikTokProfile(accessToken: string): Promise<OAuthConnectionProfile> {
    const profileUrl = `https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`

    const response = await fetch(profileUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
        }
    })

    const data = await response.json()
    console.log("TikTok profile response", JSON.stringify(data, null, 2))

    if (!response.ok || data?.error?.code !== "ok") {
        throw new Error(`Failed to fetch TikTok profile: ${data?.error?.message || response.statusText}`)
    }

    const user = data?.data?.user

    return {
        // TikTok recommends open_id as the stable per-app identifier
        providerAccountId: user?.open_id ?? null,
        handle: user?.display_name ?? null,
        profileImage: user?.avatar_url ?? null,
    }
}


// ─────────────────────────────────────────────
// TIKTOK — custom exchangeCodeForToken
// TikTok's token endpoint returns a different
// structure and needs client_key not client_id
// ─────────────────────────────────────────────

async function exchangeTikTokToken({
    code,
    redirectUri,
    codeVerifier,
}: {
    code: string
    redirectUri: string
    codeVerifier?: string
}): Promise<OAuthTokenResponse> {
    const clientId = getEnv('TIKTOK_CLIENT_ID')
    const clientSecret = getEnv('TIKTOK_CLIENT_SECRET')

    const params = new URLSearchParams({
        client_key: clientId,       // TikTok uses client_key, not client_id
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
    })

    if (codeVerifier) {
        params.append('code_verifier', codeVerifier)
    }

    const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: params,
    })

    const data = await response.json()
    console.log("TikTok token response", JSON.stringify(data, null, 2))

    if (!response.ok || data?.error) {
        throw new Error(data?.error_description || data?.error || `TikTok token exchange failed: ${response.statusText}`)
    }

    const seconds = Number(data.expires_in)
    const expiresAt = seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresAt,
    }
}


// ─────────────────────────────────────────────
// TIKTOK — custom getAuthorizationUrl
// TikTok uses client_key param instead of client_id
// and scope uses comma separator not space
// ─────────────────────────────────────────────

function getTikTokAuthorizationUrl({
    state,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
}: {
    state: string
    redirectUri: string
    codeChallenge?: string
    codeChallengeMethod?: string
}): string {
    const clientId = getEnv('TIKTOK_CLIENT_ID')
    const scopes = getEnv('TIKTOK_SCOPES').split(',').map(s => s.trim()).filter(Boolean)

    const params = new URLSearchParams({
        client_key: clientId,       // TikTok uses client_key
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(','),    // TikTok uses comma, not space
        state,
    })

    if (codeChallenge && codeChallengeMethod) {
        params.append('code_challenge', codeChallenge)
        params.append('code_challenge_method', codeChallengeMethod)
    }

    const authUrl = getEnv('TIKTOK_AUTH_URL')
    return `${authUrl}?${params.toString()}`
}


// ─────────────────────────────────────────────
// PROVIDERS MAP
// ─────────────────────────────────────────────

const PROVIDERS: Record<ChannelTypeEnum, OAuthProvider> = {
    [ChannelTypeEnum.TWITTER]: createProvider(ChannelTypeEnum.TWITTER, { pkce: true }),
    [ChannelTypeEnum.LINKEDIN]: createProvider(ChannelTypeEnum.LINKEDIN),

    // Instagram: uses generic createProvider for auth/token exchange,
    // but overrides getProfile with the custom multi-step Facebook Graph flow
    [ChannelTypeEnum.INSTAGRAM]: {
        ...createProvider(ChannelTypeEnum.INSTAGRAM),
        getProfile: async ({ accessToken }) => getInstagramProfile(accessToken),
    },

    // TikTok: fully custom because client_key and comma-scopes differ from standard OAuth
    [ChannelTypeEnum.TIKTOK]: {
        ...createProvider(ChannelTypeEnum.TIKTOK, { pkce: true }),
        getAuthorizationUrl: getTikTokAuthorizationUrl,
        exchangeCodeForToken: exchangeTikTokToken,
        getProfile: async ({ accessToken }) => getTikTokProfile(accessToken),
    },

    [ChannelTypeEnum.FACEBOOK]: createProvider(ChannelTypeEnum.FACEBOOK),
    [ChannelTypeEnum.THREADS]: createProvider(ChannelTypeEnum.THREADS),
    [ChannelTypeEnum.BLUESKY]: createProvider(ChannelTypeEnum.BLUESKY),
    [ChannelTypeEnum.YOUTUBE]: createProvider(ChannelTypeEnum.YOUTUBE),
}

export function getOAuthProvider(type: ChannelTypeEnum) {
    return PROVIDERS[type];
}

export async function refreshOauthToken(
    type: ChannelTypeEnum,
    refreshToken: string,
    redirectUri: string,
) {
    console.log("refreshing token", type, refreshToken, redirectUri)
    const provider = getOAuthProvider(type);
    if (!provider.refreshToken) {
        throw new Error('Refresh token not supported for this provider');
    }
    const result = await provider.refreshToken({ refreshToken, redirectUri });
    return result;
}