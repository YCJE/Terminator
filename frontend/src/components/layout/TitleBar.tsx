import { PanelLeftClose, PanelLeftOpen, FolderOpen, PanelRightClose } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { WindowControls } from "@/components/layout/WindowControls";
import { TerminalTab } from "@/components/layout/TerminalTab";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/authStore.ts";
import { useTranslation } from "react-i18next";
import React, { useRef } from "react";

export function TitleBar() {
    const {sessions, activeSessionId, setActiveSession, removeSession} = useSessionStore();
    const {activeView, isSidebarVisible, toggleSidebar, isFilePanelVisible, toggleFilePanel} = useUIStore();

    const isTerminalView = activeView === ViewType.Terminal;
    const showSidebarStyling = isTerminalView ? isSidebarVisible : true;

    const {isUnlocked} = useAuthStore();
    const {t} = useTranslation("sftp");

    const scrollRef = useRef<HTMLDivElement>(null);

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (scrollRef.current && e.deltaY !== 0) {
            const scrollAmount = e.deltaY;
            scrollRef.current.scrollLeft += scrollAmount;
        }
    };

    return (
        <header className="titlebar wails-drag flex h-10 shrink-0 items-end justify-between pr-0">

            {isUnlocked && (
                <div
                    className={cn(
                        "relative flex h-full w-14 shrink-0 flex-col items-center justify-center",
                        showSidebarStyling ? "bg-sidebar border-r" : "bg-transparent"
                    )}
                >
                    {isTerminalView ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleSidebar}
                            className="wails-no-drag text-muted-foreground hover:text-foreground"
                        >
                            {isSidebarVisible
                                ? <PanelLeftClose className="size-5"/>
                                : <PanelLeftOpen className="size-5"/>
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
                {sessions.map((session) => (
                    <TerminalTab
                        key={session.id}
                        session={session}
                        isActive={isTerminalView && session.id === activeSessionId}
                        onClick={() => setActiveSession(session.id)}
                        onClose={() => removeSession(session.id)}
                    />
                ))}
            </div>

            {/* 文件管理面板切换按钮：终端视图且有活跃会话时显示 */}
            {isTerminalView && activeSessionId && (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleFilePanel}
                    className="wails-no-drag mr-1 text-muted-foreground hover:text-foreground"
                    title={t("toggle_panel")}
                >
                    {isFilePanelVisible
                        ? <PanelRightClose className="size-4"/>
                        : <FolderOpen className="size-4"/>
                    }
                </Button>
            )}

            <WindowControls className="ml-12"/>

        </header>
    );
}
