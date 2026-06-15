"use client"
import * as React from "react"
import { parse, set } from "date-fns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
    Wand2,
    ScanEye,
    Lightbulb,
} from "lucide-react"
import { ScheduleDatePicker } from "./schedule-date-picker"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { ChannelType } from "@/types/channel.type"
import { ButtonGroup } from "../ui/button-group"
import { Spinner } from "../ui/spinner"
import { ImageObject } from "@/types/post.type"
import { POST_STATUS, PostStatus } from "@/constants/post"
import { getChannelIcon } from "@/constants/channels"
import ContentTextarea from "../content-textarea"
import IdeasList from "./ideas-list"
import PreviewPanel from "./preview"
import { AIAssistant } from "./ai-assitant"

interface EditPostDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    post: {
        id: string
        content: string
        images: ImageObject[]
        userChannelId: string
        scheduledDate: string
        channel?: ChannelType | null
    } | null
}

type ActionTabType = "ideas" | "ai" | "preview"

const rightTabs = [
    { id: "ideas" as ActionTabType, label: "Ideas", icon: Lightbulb },
    { id: "ai" as ActionTabType, label: "AI Assistant", icon: Wand2 },
    { id: "preview" as ActionTabType, label: "Preview", icon: ScanEye },
]

export function EditPostDialog({
    open,
    onOpenChange,
    post
}: EditPostDialogProps) {

    const queryClient = useQueryClient();

    const updatePostMutation = useMutation({
        mutationFn: async ({ postId, content, images, scheduledAt, status }: {
            postId: string,
            content: string,
            images: ImageObject[],
            scheduledAt: string,
            status?: PostStatus,
            userChannelId: string
        }) => {
            const response = await fetch(`/api/post/${postId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content, images, scheduledAt, status })
            });
            if (!response.ok) throw new Error("Failed to update post");
            return response.json();
        },
        onSuccess: (data, variables) => {
            toast.success(`Post ${variables.status === POST_STATUS.DRAFT ? "saved to drafts" : "rescheduled"} successfully!`);
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            onOpenChange(false);
        },
        onError: (error: any) => {
            console.error("Update error:", error);
            toast.error(error.message);
        }
    });

    const [content, setContent] = React.useState("")
    const [images, setImages] = React.useState<ImageObject[]>([])
    const [date, setDate] = React.useState<Date | undefined>(new Date())
    const [time, setTime] = React.useState<string>("")
    const [selectedRightTab, setSeletedRightTab] = React.useState<ActionTabType | null>(null)

    React.useEffect(() => {
        if (post) {
            setContent(post.content)
            setImages(post.images ?? [])
            const date = new Date(post.scheduledDate)
            setDate(date)
            const hours = date.getHours()
            const minutes = date.getMinutes()
            const ampm = hours >= 12 ? "PM" : "AM"
            const h = hours % 12 || 12
            const m = minutes.toString().padStart(2, "0")
            setTime(`${h}:${m} ${ampm}`)
        }
    }, [post])

    const channel = post?.channel
    const icon = channel ? getChannelIcon(channel.type) : null

    const handleUpdate = (status?: PostStatus) => {
        if (!post) return
        const parsedTime = parse(time, "h:mm a", new Date())
        const finalDate = set(date || new Date(), {
            hours: parsedTime.getHours(),
            minutes: parsedTime.getMinutes(),
            seconds: 0,
            milliseconds: 0
        })
        updatePostMutation.mutate({
            postId: post.id,
            content,
            images,
            scheduledAt: finalDate.toISOString(),
            status,
            userChannelId: post.userChannelId
        });
    }

    const handleAddIdea = (idea: any) => {
        setContent(idea.description || "")
        setImages(idea.images || [])
    }

    const handleSelectRightTab = (tab: ActionTabType) => {
        setSeletedRightTab((prev) => (prev === tab ? null : tab))
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn(
                // Mobile: full screen. sm+: auto-sized with max height
                "flex flex-col gap-0 px-0 pt-0 pb-0",
                "w-full h-dvh max-h-dvh rounded-none",
                "sm:h-auto sm:max-h-[90dvh] sm:rounded-lg",
                "sm:w-full sm:min-w-175",
                selectedRightTab ? "sm:max-w-237.5" : "sm:max-w-175"
            )}>
                {/* Outer wrapper — flex col so header + body + footer stack, footer always visible */}
                <div className="flex flex-col min-h-0 flex-1 overflow-hidden">

                    {/* ── Header ── */}
                    <DialogHeader className="px-5 sm:px-8 py-4 border-b shrink-0">
                        <div className="flex items-center justify-between">
                            <DialogTitle className="text-lg font-semibold">Edit Post</DialogTitle>
                            <div className="flex items-center gap-px">
                                {rightTabs.map((tab) => (
                                    <Button
                                        key={tab.id}
                                        variant={selectedRightTab === tab.id ? "default" : "ghost"}
                                        size="sm"
                                        className={cn(
                                            "h-8",
                                            !selectedRightTab && "w-8 px-0"
                                        )}
                                        onClick={() => handleSelectRightTab(tab.id)}
                                    >
                                        <tab.icon className="h-4 w-4 shrink-0" />
                                        <span className={cn(
                                            "ml-1 hidden",
                                            selectedRightTab && "sm:inline"
                                        )}>
                                            {tab.label}
                                        </span>
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </DialogHeader>
                    <DialogDescription />

                    {/* ── Body — scrollable, fills remaining space ── */}
                    <div className={cn(
                        "flex flex-1 min-h-0 overflow-hidden",
                        selectedRightTab ? "flex-col sm:flex-row" : "flex-row"
                    )}>

                        {/* Left panel — scrollable */}
                        <div className={cn(
                            "flex flex-col min-w-0 overflow-y-auto",
                            selectedRightTab
                                ? "shrink-0 max-h-[45dvh] sm:max-h-none sm:flex-1"
                                : "flex-1"
                        )}>
                            <section className="flex flex-col px-5 sm:px-8 pt-5 pb-5">
                                <div className="bg-background rounded-2xl border shadow-sm overflow-hidden flex flex-col p-4">
                                    <div className="flex-1 relative">
                                        {icon && (
                                            <div className="absolute top-0 left-0">
                                                <HugeiconsIcon
                                                    icon={icon}
                                                    style={{ background: channel?.color }}
                                                    className="size-5 text-white! p-1 rounded-sm"
                                                />
                                            </div>
                                        )}
                                        <div className={cn(icon && "pl-8")}>
                                            <ContentTextarea
                                                value={content}
                                                images={images}
                                                placeholder="Start writing or get inspired by AI..."
                                                minHeight={300}
                                                contentClass="text-[15px] placeholder:opacity-50 pt-0!"
                                                showAIAssistant={true}
                                                onAIAssistantClick={() => handleSelectRightTab("ai")}
                                                onChange={setContent}
                                                onImagesChange={setImages}
                                                renderToolbarRight={
                                                    <div className="flex items-center gap-3">
                                                        <span className={cn(
                                                            "text-[10px] font-medium px-2 py-0.5 rounded-full",
                                                            channel && content.length >= Number(channel.character_limit) * 0.9
                                                                ? "bg-orange-100 text-orange-600"
                                                                : "bg-muted text-muted-foreground"
                                                        )}>
                                                            {content.length} / {channel?.character_limit || 280}
                                                        </span>
                                                    </div>
                                                }
                                            />
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>

                        {/* Right Side Panel */}
                        {selectedRightTab && (
                            <aside className={cn(
                                "flex flex-col shrink-0 border-t sm:border-t-0 sm:border-l border-border bg-muted/30",
                                "h-[45dvh] sm:h-auto sm:w-87.5",
                                "sm:shrink-0"
                            )}>
                                <div className="py-4 flex-1 flex flex-col h-full overflow-y-auto">
                                    {selectedRightTab === "ai" && (
                                        <div className="px-4 sm:px-6 flex flex-col">
                                            <AIAssistant
                                                content={content}
                                                channelId={post?.channel?.id}
                                                onGenerate={(generatedText) => setContent(generatedText)}
                                            />
                                        </div>
                                    )}
                                    {selectedRightTab === "ideas" && (
                                        <IdeasList onSelect={handleAddIdea} />
                                    )}
                                    {selectedRightTab === "preview" && (
                                        <PreviewPanel
                                            channel={channel || null}
                                            content={{ text: content, images }}
                                        />
                                    )}
                                </div>
                            </aside>
                        )}
                    </div>

                    {/* ── Footer — always visible, never hidden ── */}
                    <DialogFooter className="px-5 sm:px-8 pt-4 pb-4 border-t shrink-0 m-0!">
                        <div className="w-full flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
                            <Button
                                variant="ghost"
                                size="lg"
                                onClick={() => handleUpdate(POST_STATUS.DRAFT)}
                                disabled={updatePostMutation.isPending}
                                className="shrink-0"
                            >
                                {updatePostMutation.isPending && updatePostMutation.variables?.status === POST_STATUS.DRAFT && <Spinner />}
                                Save Draft
                            </Button>
                            <ButtonGroup className="p-0! shrink-0">
                                <ScheduleDatePicker
                                    date={date}
                                    setDate={setDate}
                                    time={time}
                                    setTime={setTime}
                                    renderButton={(isDatePassed, isTimeNotAvailable) => (
                                        <Button
                                            size="lg"
                                            className="border py-4.5 px-4"
                                            onClick={() => {
                                                if (isDatePassed || isTimeNotAvailable) {
                                                    toast.error("Please select a valid time")
                                                    return;
                                                }
                                                handleUpdate()
                                            }}
                                            disabled={updatePostMutation.isPending || !date || !time || isTimeNotAvailable || isDatePassed}
                                        >
                                            {updatePostMutation.isPending && updatePostMutation.variables?.status === undefined && <Spinner />}
                                            Schedule Post
                                        </Button>
                                    )}
                                />
                            </ButtonGroup>
                        </div>
                    </DialogFooter>

                </div>
            </DialogContent>
        </Dialog>
    )
}