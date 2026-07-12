import { PanelLeftClose, PanelLeftOpen, FolderOpen, PanelRightClose, Radio } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { WindowControls } from "@/components/layout/WindowControls";
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
    const reorderSessions = useSessionStore((s) => s.reorderSessions);
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
    const {t} = useTranslation("sftp");

    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (scrollRef.current && e.deltaY !== 0) {
            scrollRef.current.scrollLeft += e.deltaY;
        }
    };

    return (
        <header className="titlebar wails-drag flex shrink-0 items-end justify-between pr-0" style={{ height: "var(--tabs-height)" }}>

            {isUnlocked && (
                <div
                    className={cn(
                        "relative flex h-full shrink-0 flex-col items-center justify-center",
                        showSidebarStyling ? "bg-sidebar border-r" : "bg-transparent"
                    )}
                    style={{ width: "var(--sidebar-width)" }}
                >
                    {isTerminalView ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleSidebar}
                            className="wails-no-drag text-muted-foreground hover:text-foreground"
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
                        <div className="absolute bottom-0 h-px w-8 bg-border"/>
                    )}
                </div>
            )}

            <div ref={scrollRef}
                 onWheel={handleWheel}
                 className="terminal-tab-bar flex h-full flex-1 items-center gap-0.5 pl-2
                            overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
            >
                {sessions.map((session, index) => (
                    <TerminalTab
                        key={session.id}
                        session={session}
                        index={index}
                        isActive={isTerminalView && session.id === activeSessionId}
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
                                reorderSessions(dragIndex, i);
                            }
                            setDragIndex(null);
                        }}
                    />
                ))}
            </div>

            {/* 文件管理面板切换按钮 + 窗口控制按钮 */}
            <div className="flex h-full items-center gap-1 pr-1">
                {isTerminalView && activeSessionId && broadcastEnabled && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleBroadcastMode}
                        className={cn("wails-no-drag", broadcastMode ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                        title={t("broadcast_mode")}
                    >
                        <Radio className="size-4"/>
                    </Button>
                )}
                {isTerminalView && activeSessionId && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleFilePanel}
                        className="wails-no-drag text-muted-foreground hover:text-foreground"
                        title={t("toggle_panel")}
                    >
                        {isFilePanelVisible
                            ? <PanelRightClose className="size-4"/>
                            : <FolderOpen className="size-4"/>
                        }
                    </Button>
                )}
                <WindowControls/>
            </div>

        </header>
    );
}
