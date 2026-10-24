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
import React, { useRef, useState } from "react";

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

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (scrollRef.current && e.deltaY !== 0) {
            scrollRef.current.scrollLeft += e.deltaY;
        }
    };

    return (
        <header className="titlebar shell-titlebar wails-drag pr-0">

            {isUnlocked && (
                <div
                    className={cn(
                        "relative flex h-full shrink-0 flex-col items-center justify-center",
                        showSidebarStyling ? "bg-sidebar border-r border-[var(--hairline)]" : "bg-transparent"
                    )}
                    style={{ width: "var(--sidebar-width)" }}
                >
                    {isTerminalView ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleSidebar}
                            className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        >
                            {isSidebarVisible
                                ? <PanelLeftClose className="size-4"/>
                                : <PanelLeftOpen className="size-4"/>
                            }
                        </Button>
                    ) : (
                        <img src="/appicon.png" alt="Terminator" className="size-5"/>
                    )}

                    {showSidebarStyling && (
                        <div className="absolute bottom-0 h-px w-8 bg-[var(--hairline-strong)]"/>
                    )}
                </div>
            )}

            <div ref={scrollRef}
                 onWheel={handleWheel}
                 className="terminal-tab-bar flex h-full flex-1 items-center gap-0.5 pl-2
                            overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
            >
                {visibleSessions.map((session, index) => (
                    <TerminalTab
                        key={session.id}
                        session={session}
                        index={index}
                        isActive={isTerminalView && session.id === activeTabId}
                        onClick={() => setActiveSession(session.id)}
                        onClose={() => removeSession(session.id)}
                        onSetColor={(color) => setSessionColor(session.id, color)}
                        onDragStart={(i) => setDragIndex(i)}
                        onDragOver={(i) => { /* visual feedback could go here */ }}
                        onDragEnd={() => {
                            setDragIndex(null);
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
                        }}
                    />
                ))}
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
