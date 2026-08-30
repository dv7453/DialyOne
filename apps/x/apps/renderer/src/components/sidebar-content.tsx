"use client"

import * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowUpRight,
  ChevronRight,
  AlertTriangle,
  MoreVertical,
  Pencil,
  Pin,
  SquarePen,
  Trash2,
  Plug,
  LoaderIcon,
  MessageSquare,
  Settings,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { SettingsDialog } from "@/components/settings-dialog"
import { toast } from "@/lib/toast"
import { ServiceEvent } from "@x/shared/src/service-events.js"
import z from "zod"

type ServiceEventType = z.infer<typeof ServiceEvent>

const MAX_SYNC_EVENTS = 1000
const RUN_STALE_MS = 2 * 60 * 60 * 1000
const PINNED_CHATS_STORAGE_KEY = 'x:pinned-chats'
const MAX_PINNED_CHATS = 3

const SERVICE_LABELS: Record<string, string> = {
  gmail: "Syncing Gmail",
  outlook: "Syncing Outlook",
  calendar: "Syncing Calendar",
  fireflies: "Syncing Fireflies",
  granola: "Syncing Granola",
  graph: "Updating knowledge",
  voice_memo: "Processing voice memo",
  email_labeling: "Labeling emails",
  note_tagging: "Tagging notes",
  agent_notes: "Updating agent notes",
}

function summarizeServiceError(error: string): string {
  const firstLine = error.split("\n").find((line) => line.trim().length > 0)
  return firstLine?.trim() || error.trim()
}

function collectServiceErrors(events: ServiceEventType[]): Map<string, string> {
  const errors = new Map<string, string>()
  for (const event of events) {
    if (event.type === "error") {
      errors.set(event.service, summarizeServiceError(event.error))
      continue
    }
    if (event.type === "run_complete" && event.outcome !== "error") {
      errors.delete(event.service)
    }
  }
  return errors
}

type SidebarContentPanelProps = {
  recentRuns?: { id: string; title?: string; createdAt: string; modifiedAt?: string }[]
  onOpenRun?: (runId: string) => void
  /** Persist a custom chat title (sessions:setTitle) and refresh the runs list. */
  onRenameRun?: (runId: string, title: string) => void
  /** Delete the chat's session (sessions:delete) and refresh the runs list. */
  onDeleteRun?: (runId: string) => void
  onOpenChatHistory?: () => void
  onNewChat?: () => void
} & React.ComponentProps<typeof Sidebar>

function formatEventTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function SyncStatusBar() {
  const { state } = useSidebar()
  const [activeServices, setActiveServices] = useState<Map<string, string>>(new Map())
  const [serviceErrors, setServiceErrors] = useState<Map<string, string>>(new Map())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [logEvents, setLogEvents] = useState<ServiceEventType[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const runTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Track active runs from real-time events
  useEffect(() => {
    const cleanup = window.ipc.on('services:events', (event) => {
      const nextEvent = event as ServiceEventType
      if (nextEvent.type === 'run_start') {
        setActiveServices((prev) => {
          const next = new Map(prev)
          next.set(nextEvent.runId, nextEvent.service)
          return next
        })
        const existingTimeout = runTimeoutsRef.current.get(nextEvent.runId)
        if (existingTimeout) clearTimeout(existingTimeout)
        const timeout = setTimeout(() => {
          setActiveServices((prev) => {
            if (!prev.has(nextEvent.runId)) return prev
            const next = new Map(prev)
            next.delete(nextEvent.runId)
            return next
          })
          runTimeoutsRef.current.delete(nextEvent.runId)
        }, RUN_STALE_MS)
        runTimeoutsRef.current.set(nextEvent.runId, timeout)
      } else if (nextEvent.type === 'run_complete') {
        setActiveServices((prev) => {
          const next = new Map(prev)
          next.delete(nextEvent.runId)
          return next
        })
        if (nextEvent.outcome !== 'error') {
          setServiceErrors((prev) => {
            if (!prev.has(nextEvent.service)) return prev
            const next = new Map(prev)
            next.delete(nextEvent.service)
            return next
          })
        }
        const existingTimeout = runTimeoutsRef.current.get(nextEvent.runId)
        if (existingTimeout) {
          clearTimeout(existingTimeout)
          runTimeoutsRef.current.delete(nextEvent.runId)
        }
      } else if (nextEvent.type === 'error') {
        setServiceErrors((prev) => {
          const next = new Map(prev)
          next.set(nextEvent.service, summarizeServiceError(nextEvent.error))
          return next
        })
      }
    })
    return cleanup
  }, [])

  useEffect(() => {
    return () => {
      runTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
      runTimeoutsRef.current.clear()
    }
  }, [])

  // Load logs from JSONL file when popover opens
  useEffect(() => {
    if (!popoverOpen) return
    let cancelled = false
    async function loadLogs() {
      setLogLoading(true)
      try {
        const result = await window.ipc.invoke('workspace:readFile', {
          path: 'logs/services.jsonl',
          encoding: 'utf8',
        })
        if (cancelled) return
        const lines = result.data.trim().split('\n').filter(Boolean)
        const parsed: ServiceEventType[] = []
        for (const line of lines) {
          try {
            parsed.push(JSON.parse(line))
          } catch {
            // skip malformed lines
          }
        }
        setServiceErrors(collectServiceErrors(parsed))
        // Newest first, limit to 1000
        setLogEvents(parsed.reverse().slice(0, MAX_SYNC_EVENTS))
      } catch {
        if (!cancelled) {
          setLogEvents([])
          setServiceErrors(new Map())
        }
      } finally {
        if (!cancelled) setLogLoading(false)
      }
    }
    loadLogs()
    return () => { cancelled = true }
  }, [popoverOpen])

  const isSyncing = activeServices.size > 0
  const isCollapsed = state === "collapsed"
  const errorEntries = Array.from(serviceErrors.entries())
  const primaryErrorService = errorEntries[0]?.[0] ?? null
  const hasServiceErrors = errorEntries.length > 0

  // Build status label from active services
  const activeServiceNames = [...new Set(activeServices.values())]
  const statusLabel = isSyncing
    ? activeServiceNames.map((s) => SERVICE_LABELS[s] || s).join(", ")
    : hasServiceErrors
      ? errorEntries.length === 1
        ? `${SERVICE_LABELS[primaryErrorService ?? ""] || primaryErrorService} failed`
        : "Recent sync issues"
      : "All caught up"

  return (
    <>
      {isCollapsed && isSyncing && (
        <div
          className="fixed bottom-4 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background shadow-sm"
          style={{ left: "0.5rem" }}
          aria-label="Syncing"
        >
          <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <SidebarFooter className="border-t border-sidebar-border px-2 py-2">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-sidebar-accent",
                hasServiceErrors && !isSyncing ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                {isSyncing ? (
                  <LoaderIcon className="h-3 w-3 shrink-0 animate-spin" />
                ) : hasServiceErrors ? (
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                )}
                <span className="truncate">{statusLabel}</span>
              </span>
              <ChevronRight className="h-3 w-3 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="end"
            sideOffset={4}
            className="w-96 p-0"
          >
            <div className="p-3 border-b">
              <h4 className="font-semibold text-sm">Sync Activity</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isSyncing || hasServiceErrors ? statusLabel : "All services up to date"}
              </p>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {logLoading ? (
                <div className="flex items-center justify-center py-4">
                  <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : logEvents.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No recent activity.
                </div>
              ) : (
                <div className="space-y-0.5">
                  {logEvents.map((event, idx) => (
                    <div
                      key={`${event.runId}-${event.ts}-${idx}`}
                      className="flex items-start gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
                    >
                      <span className="shrink-0 text-[10px] leading-4 text-muted-foreground/70">
                        {formatEventTime(event.ts)}
                      </span>
                      <span className="shrink-0">
                        <span className={cn(
                          "inline-block rounded px-1 py-0.5 text-[10px] font-medium leading-none",
                          event.level === 'error' ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                          event.level === 'warn' ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                          "bg-muted text-muted-foreground"
                        )}>
                          {SERVICE_LABELS[event.service]?.split(" ").slice(-1)[0] || event.service}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="leading-4 text-foreground/80">{event.message}</p>
                        {event.type === 'error' && (
                          <p
                            className="truncate text-[11px] leading-4 text-red-600/90 dark:text-red-400/90"
                            title={event.error}
                          >
                            {summarizeServiceError(event.error)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </>
  )
}

export function SidebarContentPanel({
  recentRuns = [],
  onOpenRun,
  onRenameRun,
  onDeleteRun,
  onOpenChatHistory,
  onNewChat,
  ...props
}: SidebarContentPanelProps) {
  const [hasOauthError, setHasOauthError] = useState(false)
  const [showOauthAlert, setShowOauthAlert] = useState(true)
  const [connectionsSettingsOpen, setConnectionsSettingsOpen] = useState(false)
  const [openConnectionsAfterClose, setOpenConnectionsAfterClose] = useState(false)
  const connectorsButtonRef = useRef<HTMLButtonElement | null>(null)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  // Pinned chats: a per-machine UI preference, persisted in localStorage.
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_CHATS_STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const toggleChatPin = useCallback((chatId: string) => {
    const isPinned = pinnedChatIds.includes(chatId)
    // Count only pins that still resolve to a chat — deleted chats leave
    // stale ids in localStorage and must not eat pin slots.
    const activePinCount = pinnedChatIds.filter((id) => recentRuns.some((r) => r.id === id)).length
    if (!isPinned && activePinCount >= MAX_PINNED_CHATS) {
      toast(`You can pin up to ${MAX_PINNED_CHATS} chats`, 'error')
      return
    }
    const next = isPinned ? pinnedChatIds.filter((id) => id !== chatId) : [...pinnedChatIds, chatId]
    try {
      window.localStorage.setItem(PINNED_CHATS_STORAGE_KEY, JSON.stringify(next))
    } catch { /* ignore */ }
    setPinnedChatIds(next)
  }, [pinnedChatIds, recentRuns])

  // Chats: pinned first, then the most recently modified, 10 rows total.
  const recentChats = React.useMemo(() => {
    const chatRecency = (r: { createdAt: string; modifiedAt?: string }) => {
      const ms = new Date(r.modifiedAt ?? r.createdAt).getTime()
      return Number.isFinite(ms) ? ms : 0
    }
    const sorted = [...recentRuns].sort((a, b) => chatRecency(b) - chatRecency(a))
    const pinned = sorted.filter((r) => pinnedChatIds.includes(r.id))
    const rest = sorted.filter((r) => !pinnedChatIds.includes(r.id))
    return [...pinned, ...rest.slice(0, Math.max(0, 10 - pinned.length))]
  }, [recentRuns, pinnedChatIds])

  // Chat pending delete confirmation, if any.
  const [deleteChatTarget, setDeleteChatTarget] = useState<{ id: string; title: string } | null>(null)

  // Inline chat rename: which row is editing and its draft text.
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const commitChatRename = useCallback((chatId: string) => {
    const title = renameDraft.trim()
    const current = recentChats.find((c) => c.id === chatId)
    setRenamingChatId(null)
    if (!title || title === (current?.title ?? '')) return
    onRenameRun?.(chatId, title)
  }, [renameDraft, recentChats, onRenameRun])

  useEffect(() => {
    let mounted = true

    const refreshOauthError = async () => {
      try {
        const result = await window.ipc.invoke('oauth:getState', null)
        const config = result.config || {}
        const hasError = Object.values(config).some((entry) => Boolean(entry?.error))
        if (mounted) {
          setHasOauthError(hasError)
          if (!hasError) {
            setShowOauthAlert(true)
          }
        }
      } catch (error) {
        console.error('Failed to fetch OAuth state:', error)
        if (mounted) {
          setHasOauthError(false)
          setShowOauthAlert(true)
        }
      }
    }

    refreshOauthError()
    const cleanup = window.ipc.on('oauth:didConnect', () => {
      refreshOauthError()
    })

    return () => {
      mounted = false
      cleanup()
    }
  }, [])

  return (
    <Sidebar className="rowboat-sidebar border-r-0" {...props}>
      <SidebarHeader className="titlebar-drag-region">
        {/* Top spacer to clear the traffic lights + fixed toggle row */}
        <div className="h-8" />
        {/* Quick actions */}
        <div className="titlebar-no-drag flex items-center gap-1 pl-3 pr-6 pb-2">
          {onNewChat && (
            <button
              type="button"
              onClick={onNewChat}
              className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-sidebar-border text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <SquarePen className="size-3.5" />
              New chat
            </button>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <div className="mx-3 border-t border-sidebar-border" />
        {/* Chats */}
        <SidebarGroup className="flex flex-col">
          <SidebarGroupContent>
            <button
              type="button"
              data-tour-id="nav-chats"
              onClick={() => setChatsExpanded((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              <ChevronRight className={cn('size-3 transition-transform', chatsExpanded && 'rotate-90')} />
              <span className="flex-1 text-left">Chats</span>
            </button>
            {chatsExpanded && (
              recentChats.length === 0 ? (
                <div className="px-4 pb-2 text-[11.5px] italic text-muted-foreground">
                  Your recent chats show up here.
                </div>
              ) : (
                <SidebarMenu>
                  {recentChats.map((chat) => (
                    <SidebarMenuItem key={chat.id}>
                      {renamingChatId === chat.id ? (
                        <div className="flex h-8 items-center gap-2 rounded-md px-2">
                          <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitChatRename(chat.id)
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                setRenamingChatId(null)
                              }
                            }}
                            onBlur={() => commitChatRename(chat.id)}
                            className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      ) : (
                        <>
                          <SidebarMenuButton onClick={() => onOpenRun?.(chat.id)} className={onRenameRun ? 'pr-7' : undefined}>
                            <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex-1 truncate">{chat.title || '(Untitled chat)'}</span>
                            {pinnedChatIds.includes(chat.id) && (
                              <Pin className="size-3 shrink-0 text-muted-foreground/70 transition-opacity group-hover/menu-item:opacity-0" />
                            )}
                          </SidebarMenuButton>
                          {onRenameRun && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label="Chat options"
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/menu-item:opacity-100 data-[state=open]:opacity-100"
                                >
                                  <MoreVertical className="size-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start">
                                <DropdownMenuItem onClick={() => toggleChatPin(chat.id)}>
                                  <Pin className="mr-2 size-3.5" />
                                  {pinnedChatIds.includes(chat.id) ? 'Unpin' : 'Pin'}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenameDraft(chat.title || '')
                                    setRenamingChatId(chat.id)
                                  }}
                                >
                                  <Pencil className="mr-2 size-3.5" />
                                  Rename
                                </DropdownMenuItem>
                                {onDeleteRun && (
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() => setDeleteChatTarget({ id: chat.id, title: chat.title || '(Untitled chat)' })}
                                  >
                                    <Trash2 className="mr-2 size-3.5" />
                                    Delete
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </>
                      )}
                    </SidebarMenuItem>
                  ))}
                  {onOpenChatHistory && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => onOpenChatHistory()}
                        className="text-muted-foreground"
                      >
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">View all</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              )
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <AlertDialog open={!!deleteChatTarget} onOpenChange={(open) => { if (!open) setDeleteChatTarget(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete chat?</AlertDialogTitle>
              <AlertDialogDescription>
                &ldquo;{deleteChatTarget?.title}&rdquo; and its full history will be permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  if (deleteChatTarget) onDeleteRun?.(deleteChatTarget.id)
                  setDeleteChatTarget(null)
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SidebarContent>
      {/* Bottom actions */}
      <div className="border-t border-sidebar-border px-2 py-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <button
              ref={connectorsButtonRef}
              onClick={() => setConnectionsSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            >
              <Plug className="size-4" />
              <span>Connect Accounts</span>
            </button>
            {hasOauthError && (
              <AlertDialog
                open={showOauthAlert}
                onOpenChange={setShowOauthAlert}
              >
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center"
                    aria-label="OAuth connection issues"
                  >
                    <AlertTriangle className="size-3 text-amber-500/90 animate-pulse" />
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    if (openConnectionsAfterClose) {
                      setOpenConnectionsAfterClose(false)
                      setConnectionsSettingsOpen(true)
                    }
                    connectorsButtonRef.current?.focus()
                  }}
                >
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reconnect your accounts</AlertDialogTitle>
                    <AlertDialogDescription>
                      One or more connected accounts need attention. Open Connected accounts
                      to review the status and reconnect if needed.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel
                      onClick={() => {
                        setOpenConnectionsAfterClose(false)
                        setShowOauthAlert(false)
                      }}
                    >
                      Dismiss
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setOpenConnectionsAfterClose(true)
                        setShowOauthAlert(false)
                      }}
                    >
                      View connected accounts
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          <SettingsDialog>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
              <Settings className="size-4" />
              <span>Settings</span>
            </button>
          </SettingsDialog>
        </div>
      </div>
      <SettingsDialog
        defaultTab="connections"
        open={connectionsSettingsOpen}
        onOpenChange={setConnectionsSettingsOpen}
      />
      <SyncStatusBar />
      <SidebarRail />
    </Sidebar>
  )
}
