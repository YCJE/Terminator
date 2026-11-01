import { PanelLeftClose, PanelLeftOpen, FolderOpen, PanelRightClose, Radio, Columns2, Rows2, X, SquareTerminal, Plus, Zap, Server } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { WindowControls } from "@/components/layout/WindowControls";
import { SystemStatsButton } from "@/components/layout/SessionStatusIndicators";
import { TerminalTab } from "@/components/layout/TerminalTab";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MAX_PANES, countPanes, firstPaneSession, isPaneSession } from "@/lib/paneLayout";
import { isSshKind } from "@/lib/sessionBackend";
import { popOutSession } from "@/lib/floatingWindows";
import { useAuthStore } from "@/store/authStore.ts";
import { useTransferStore } from "@/store/transferStore";
import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "@/store/sessionStore";

export function TitleBar() {
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const setActiveSession = useSessionStore((s) => s.setActiveSession);
    const removeSession = useSessionStore((s) => s.removeSession);
    const reorderSessionsByIds = useSessionStore((s) => s.reorderSessionsByIds);
    const addLocalSession = useSessionStore((s) => s.addLocalSession);
    const layout = useSessionStore((s) => s.layout);
    const splitActiveSession = useSessionStore((s) => s.splitActiveSession);
    const closeSplit = useSessionStore((s) => s.closeSplit);
    const setSessionColor = useSessionStore((s) => s.setSessionColor);
    const renameSession = useSessionStore((s) => s.renameSession);
    const duplicateSession = useSessionStore((s) => s.duplicateSession);
    const closeOtherSessions = useSessionStore((s) => s.closeOtherSessions);
    const closeSessionsToRight = useSessionStore((s) => s.closeSessionsToRight);
    const reconnectSession = useSessionStore((s) => s.reconnectSession);
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const toggleBroadcastMode = useSessionStore((s) => s.toggleBroadcastMode);
    const broadcastEnabled = useUIStore((s) => s.broadcastEnabled);
    const activeView = useUIStore((s) => s.activeView);
    const isSidebarVisible = useUIStore((s) => s.isSidebarVisible);
    const toggleSidebar = useUIStore((s) => s.toggleSidebar);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
    const setQuickConnectOpen = useUIStore((s) => s.setQuickConnectOpen);
    const setActiveView = useUIStore((s) => s.setActiveView);

    const isTerminalView = activeView === ViewType.Terminal;
    const isSettingsView = activeView === ViewType.Settings;
    // 设置页隐藏主侧栏后，标题栏品牌区与设置分类导航同宽，
    // 保证两条竖线在视觉上连续，而不是留下一条错位的空白。
    const showSidebarStyling = isTerminalView ? isSidebarVisible : !isSettingsView;
    const brandIsRail = showSidebarStyling || isSettingsView;
    const brandWidth = isSettingsView
        ? "var(--settings-nav-width)"
        : showSidebarStyling
            ? "var(--sidebar-width)"
            : "calc(48px * var(--spaciness))";

    const {isUnlocked} = useAuthStore();
    const {t: tSftp} = useTranslation("sftp");
    const {t: tTerm} = useTranslation("terminal");

    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    // 标签条两端是否还有未显示的标签，用于渐隐提示可继续滚动
    const [tabOverflow, setTabOverflow] = useState({ start: false, end: false });
    // 关闭前待确认的标签：开启"关闭标签页前确认"且有活跃连接/传输时使用
    const [pendingClose, setPendingClose] = useState<TerminalSession | null>(null);

    /**
     * 关闭标签
     * 仅在会话仍处于连接状态（或有活跃文件传输）且用户开启了关闭确认时弹窗，
     * 已断开的标签直接关闭，避免每次关闭都多一步点击。
     */
    const requestClose = (session: TerminalSession) => {
        const hasActiveTransfer = useTransferStore.getState().transfers.some(
            (transfer) => transfer.sessionId === session.id && transfer.status === "active",
        );
        const needsConfirm = session.status === "connected" || hasActiveTransfer;
        if (!useUIStore.getState().closeTabConfirm || !needsConfirm) {
            removeSession(session.id);
            return;
        }
        setPendingClose(session);
    };

    // 分屏副窗格不进入标签栏；焦点落在任一窗格时高亮该组布局的代表标签
    const visibleSessions = sessions.filter((s) => !s.isSplitPane);
    const paneInLayout = !!layout && !!activeSessionId && isPaneSession(layout, activeSessionId);
    const activeTabId = paneInLayout ? firstPaneSession(layout) ?? activeSessionId : activeSessionId;
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    // 延迟与资源采样依赖 SSH 会话；本地 / Telnet / 串口均不提供
    const activeIsSsh = isSshKind(activeSession?.kind);
    // 布局内任一窗格都可继续拆分；布局外的标签暂不支持（同一时间只维护一组布局）
    const paneCount = layout ? countPanes(layout) : 0;
    const paneLimitReached = paneCount >= MAX_PANES;
    const canSplit = !!activeSession && !activeSession.disconnected
        && (!layout || paneInLayout) && !paneLimitReached;
    // 延迟与资源采样都依赖后端已建立的 SSH 会话，连接中/断开时不显示
    const sessionConnected = activeSession?.status === "connected" && activeIsSsh;

    const updateTabOverflow = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const max = el.scrollWidth - el.clientWidth;
        setTabOverflow((prev) => {
            const next = {start: el.scrollLeft > 1, end: max - el.scrollLeft > 1};
            // 状态未变时返回原对象，避免滚动过程中持续重渲染
            return prev.start === next.start && prev.end === next.end ? prev : next;
        });
    }, []);

    // 容器缩放或标签数量变化时重算两端渐隐状态
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        updateTabOverflow();
        const observer = new ResizeObserver(updateTabOverflow);
        observer.observe(el);
        return () => observer.disconnect();
    }, [updateTabOverflow, visibleSessions.length]);

    // 激活标签（含新建标签）始终滚入视口：只在越界时移动，避免每次切换都抖动
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !activeTabId) return;
        const tab = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
        if (!tab) return;
        const barRect = el.getBoundingClientRect();
        const tabRect = tab.getBoundingClientRect();
        const pad = 8;
        // 尊重系统「减少动效」偏好：该设置只降级 CSS，JS 平滑滚动需要单独判断
        const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth";
        if (tabRect.left < barRect.left + pad) {
            el.scrollTo({left: el.scrollLeft + tabRect.left - barRect.left - pad, behavior});
        } else if (tabRect.right > barRect.right - pad) {
            el.scrollTo({left: el.scrollLeft + tabRect.right - barRect.right + pad, behavior});
        }
    }, [activeTabId, visibleSessions.length]);

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        // 竖直滚轮映射为横向滚动；触控板的横向手势交给原生滚动
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft += e.deltaY;
        }
    };

    return (
        <header className="titlebar shell-titlebar wails-drag pr-0">

            {isUnlocked && (
                <div
                    className={cn(
                        "relative flex h-full shrink-0 items-center",
                        brandIsRail
                            ? "bg-sidebar border-r border-[var(--hairline)]"
                            : "bg-transparent"
                    )}
                    style={{width: brandWidth}}
                >
                    {isTerminalView ? (
                        <div className="flex h-full w-full min-w-0 items-center gap-2 pl-3">
                            {showSidebarStyling && (
                                <>
                                    <img src="/appicon.png" alt="Terminator" className="size-5 shrink-0"/>
                                    <strong className="truncate text-[12.5px] text-[var(--fg-strong)]">
                                        Terminator
                                    </strong>
                                </>
                            )}
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={toggleSidebar}
                                title={tTerm("toggle_sidebar")}
                                aria-label={tTerm("toggle_sidebar")}
                                className="wails-no-drag ml-auto mr-1 shrink-0 text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                            >
                                {isSidebarVisible
                                    ? <PanelLeftClose className="size-4"/>
                                    : <PanelLeftOpen className="size-4"/>
                                }
                            </Button>
                        </div>
                    ) : (
                        <div className="shell-brand wails-drag">
                            <img src="/appicon.png" alt="Terminator" className="size-5 shrink-0"/>
                            <strong>Terminator</strong>
                        </div>
                    )}
                </div>
            )}

            <div className="relative flex h-full min-w-0 flex-1 items-center">
                <div ref={scrollRef}
                     onWheel={handleWheel}
                     onScroll={updateTabOverflow}
                     className="terminal-tab-bar terminal-tab-scroller flex h-full w-full items-center gap-0.5 pl-2 pr-2
                                overflow-x-auto overflow-y-hidden"
                >
                {visibleSessions.map((session, index) => (
                    <TerminalTab
                        key={session.id}
                        session={session}
                        index={index}
                        isActive={isTerminalView && session.id === activeTabId}
                        isDragging={dragIndex === index}
                        dropSide={
                            dragIndex !== null && dragOverIndex === index && dragIndex !== index
                                ? dragIndex < index ? "after" : "before"
                                : undefined
                        }
                        onClick={() => setActiveSession(session.id)}
                        onClose={() => requestClose(session)}
                        onRename={(title) => renameSession(session.id, title)}
                        onDuplicate={() => duplicateSession(session.id)}
                        onReconnect={() => reconnectSession(session.id)}
                        onFloat={() => void popOutSession(session)}
                        onCloseOthers={() => closeOtherSessions(session.id)}
                        onCloseRight={() => closeSessionsToRight(session.id)}
                        onSetColor={(color) => setSessionColor(session.id, color)}
                        onDragStart={(i) => setDragIndex(i)}
                        onDragOver={(i) => setDragOverIndex(i)}
                        onDragEnd={() => {
                            setDragIndex(null);
                            setDragOverIndex(null);
                        }}
                        onDrop={(i) => {
                            if (dragIndex !== null && dragIndex !== i) {
                                const from = visibleSessions[dragIndex];
                                const to = visibleSessions[i];
                                if (from && to) {
                                    reorderSessionsByIds(from.id, to.id);
                                }
                            }
                            setDragIndex(null);
                            setDragOverIndex(null);
                        }}
                    />
                ))}
                    {/* 新建标签入口：终端用户的"下一步动作"就近放在标签末尾（Termius / Tabby 习惯） */}
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className="terminal-tab-new wails-no-drag"
                                title={tTerm("new_tab")}
                                aria-label={tTerm("new_tab")}
                            >
                                <Plus className="size-3.5"/>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-52">
                            <DropdownMenuItem onClick={() => addLocalSession(tTerm("local_terminal_title"))}>
                                <SquareTerminal className="mr-2 size-4"/>
                                {tTerm("new_tab_local")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setQuickConnectOpen(true)}>
                                <Zap className="mr-2 size-4"/>
                                {tTerm("new_tab_quick")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setActiveView(ViewType.Hosts); }}>
                                <Server className="mr-2 size-4"/>
                                {tTerm("new_tab_hosts")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                {/* 两端渐隐：仅当对应方向还有未显示的标签时出现 */}
                <div className={cn("terminal-tab-fade is-left", tabOverflow.start && "is-visible")}/>
                <div className={cn("terminal-tab-fade is-right", tabOverflow.end && "is-visible")}/>
            </div>

            {/* 会话状态与操作区：状态（资源）｜分屏｜广播/文件/本地终端｜窗口控制 */}
            <div className="flex h-full items-center gap-0.5 pr-0">
                {isTerminalView && sessionConnected && (
                    <SystemStatsButton sessionId={activeSessionId}/>
                )}
                {isTerminalView && sessionConnected && (
                    <div className="shell-titlebar-sep"/>
                )}
                {isTerminalView && activeSessionId && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canSplit}
                            onClick={() => splitActiveSession("row")}
                            className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                            title={paneLimitReached ? tTerm("split_limit") : tTerm("split_vertical")}
                            aria-label={paneLimitReached ? tTerm("split_limit") : tTerm("split_vertical")}
                        >
                            <Columns2 className="size-4"/>
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canSplit}
                            onClick={() => splitActiveSession("column")}
                            className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                            title={paneLimitReached ? tTerm("split_limit") : tTerm("split_horizontal")}
                            aria-label={paneLimitReached ? tTerm("split_limit") : tTerm("split_horizontal")}
                        >
                            <Rows2 className="size-4"/>
                        </Button>
                        {paneInLayout && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={closeSplit}
                                className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                                title={tTerm("split_close")}
                                aria-label={tTerm("split_close")}
                            >
                                <X className="size-4"/>
                            </Button>
                        )}
                    </>
                )}
                {isTerminalView && activeSessionId && (
                    <div className="shell-titlebar-sep"/>
                )}
                {isTerminalView && activeSessionId && broadcastEnabled && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleBroadcastMode}
                        className={cn("wails-no-drag", broadcastMode ? "text-primary" : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]")}
                        title={broadcastMode ? tTerm("broadcast_on") : tTerm("broadcast_off")}
                        aria-label={broadcastMode ? tTerm("broadcast_on") : tTerm("broadcast_off")}
                    >
                        <Radio className="size-4"/>
                    </Button>
                )}
                {isTerminalView && activeSessionId && activeIsSsh && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleFilePanel}
                        className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        title={tSftp("toggle_panel")}
                        aria-label={tSftp("toggle_panel")}
                    >
                        {isFilePanelVisible
                            ? <PanelRightClose className="size-4"/>
                            : <FolderOpen className="size-4"/>
                        }
                    </Button>
                )}
                {isUnlocked && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => addLocalSession(tTerm("local_terminal_title"))}
                        className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        title={tTerm("open_local_terminal")}
                        aria-label={tTerm("open_local_terminal")}
                    >
                        <SquareTerminal className="size-4"/>
                    </Button>
                )}
                <div className="shell-titlebar-sep mr-1"/>
                <WindowControls/>
            </div>

            <ConfirmModal
                isOpen={!!pendingClose}
                onClose={() => setPendingClose(null)}
                onConfirm={() => {
                    if (pendingClose) removeSession(pendingClose.id);
                    setPendingClose(null);
                }}
                title={tTerm("close_tab_confirm_title")}
                description={tTerm("close_tab_confirm_body", {title: pendingClose?.title ?? ""})}
                confirmText={tTerm("close_tab_confirm_action")}
            />
        </header>
    );
}
