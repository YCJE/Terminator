import { PanelLeftClose, PanelLeftOpen, FolderOpen, PanelRightClose, Radio, Columns2, Rows2, X, SquareTerminal } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { WindowControls } from "@/components/layout/WindowControls";
import { LatencyBadge, SystemStatsButton } from "@/components/layout/SessionStatusIndicators";
import { TerminalTab } from "@/components/layout/TerminalTab";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/authStore.ts";
import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useRef, useState } from "react";

export function TitleBar() {
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const setActiveSession = useSessionStore((s) => s.setActiveSession);
    const removeSession = useSessionStore((s) => s.removeSession);
    const reorderSessionsByIds = useSessionStore((s) => s.reorderSessionsByIds);
    const addLocalSession = useSessionStore((s) => s.addLocalSession);
    const split = useSessionStore((s) => s.split);
    const splitActiveSession = useSessionStore((s) => s.splitActiveSession);
    const closeSplit = useSessionStore((s) => s.closeSplit);
    const setSessionColor = useSessionStore((s) => s.setSessionColor);
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const toggleBroadcastMode = useSessionStore((s) => s.toggleBroadcastMode);
    const broadcastEnabled = useUIStore((s) => s.broadcastEnabled);
    const activeView = useUIStore((s) => s.activeView);
    const isSidebarVisible = useUIStore((s) => s.isSidebarVisible);
    const toggleSidebar = useUIStore((s) => s.toggleSidebar);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);

    const isTerminalView = activeView === ViewType.Terminal;
    const showSidebarStyling = isTerminalView ? isSidebarVisible : true;

    const {isUnlocked} = useAuthStore();
    const {t: tSftp} = useTranslation("sftp");
    const {t: tTerm} = useTranslation("terminal");

    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    // 标签条两端是否还有未显示的标签，用于渐隐提示可继续滚动
    const [tabOverflow, setTabOverflow] = useState({ start: false, end: false });

    // 分屏副窗格不进入标签栏；焦点落在副窗格时高亮其主窗格的标签
    const visibleSessions = sessions.filter((s) => !s.isSplitPane);
    const activeTabId = split &&
        (activeSessionId === split.primaryId || activeSessionId === split.secondaryId)
        ? split.primaryId
        : activeSessionId;
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    // 本地终端没有延迟、资源面板与 SFTP 文件管理
    const activeIsLocal = activeSession?.kind === "local";
    const canSplit = !!activeSession && !activeSession.disconnected && !activeSession.isSplitPane;
    // 延迟与资源采样都依赖后端已建立的 SSH 会话，连接中/断开时不显示
    const sessionConnected = activeSession?.status === "connected" && !activeIsLocal;

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
                        showSidebarStyling
                            ? "bg-sidebar border-r border-[var(--hairline)]"
                            : "bg-transparent"
                    )}
                    style={{
                        width: showSidebarStyling
                            ? "var(--sidebar-width)"
                            : "calc(48px * var(--spaciness))",
                    }}
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
                        onClose={() => removeSession(session.id)}
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
                </div>
                {/* 两端渐隐：仅当对应方向还有未显示的标签时出现 */}
                <div className={cn("terminal-tab-fade is-left", tabOverflow.start && "is-visible")}/>
                <div className={cn("terminal-tab-fade is-right", tabOverflow.end && "is-visible")}/>
            </div>

            {/* 文件管理面板切换按钮 + 窗口控制按钮 */}
            <div className="flex h-full items-center gap-1 pr-1">
                {isTerminalView && sessionConnected && (
                    <>
                        <LatencyBadge sessionId={activeSessionId}/>
                        <SystemStatsButton sessionId={activeSessionId}/>
                    </>
                )}
                {isTerminalView && activeSessionId && !split && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canSplit}
                            onClick={() => splitActiveSession("row")}
                            className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                            title={tTerm("split_vertical")}
                        >
                            <Columns2 className="size-4"/>
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canSplit}
                            onClick={() => splitActiveSession("column")}
                            className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                            title={tTerm("split_horizontal")}
                        >
                            <Rows2 className="size-4"/>
                        </Button>
                    </>
                )}
                {isTerminalView && split && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={closeSplit}
                        className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        title={tTerm("split_close")}
                    >
                        <X className="size-4"/>
                    </Button>
                )}
                {isTerminalView && activeSessionId && broadcastEnabled && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleBroadcastMode}
                        className={cn("wails-no-drag", broadcastMode ? "text-primary" : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]")}
                        title={broadcastMode ? tTerm("broadcast_on") : tTerm("broadcast_off")}
                    >
                        <Radio className="size-4"/>
                    </Button>
                )}
                {isTerminalView && activeSessionId && !activeIsLocal && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleFilePanel}
                        className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        title={tSftp("toggle_panel")}
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
                    >
                        <SquareTerminal className="size-4"/>
                    </Button>
                )}
                <WindowControls/>
            </div>

        </header>
    );
}
