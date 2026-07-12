import { useEffect } from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import { Code2, ChevronUp, ChevronDown } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";
import { TerminalInstance } from "@/components/terminal/TerminalInstance";
import { SnippetPanel } from "@/components/terminal/SnippetPanel";
import { FilePanel } from "@/components/sftp/FilePanel";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SFTP_PROGRESS_EVENT, SFTP_COMPLETE_EVENT } from "@/lib/sftpEvents";

interface TerminalStackProps {
    isVisible: boolean;
}

export function TerminalStack({isVisible}: TerminalStackProps) {
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const isSnippetPanelVisible = useUIStore((s) => s.isSnippetPanelVisible);
    const toggleSnippetPanel = useUIStore((s) => s.toggleSnippetPanel);
    // 只订阅 updateTransfer 函数引用（不会随传输进度变化），避免高频重渲染
    const updateTransfer = useTransferStore((s) => s.updateTransfer);
    const { t } = useTranslation("terminal");

    // 全局监听 SFTP 传输进度与完成事件，实时更新传输队列状态
    useEffect(() => {
        const offProgress = Events.On(SFTP_PROGRESS_EVENT, (event) => {
            const d = event?.data;
            if (d?.transferId !== undefined) {
                updateTransfer(d.transferId, {
                    transferred: d.transferred ?? 0,
                    total: d.total ?? 0,
                    status: "active",
                });
            }
        });

        const offComplete = Events.On(SFTP_COMPLETE_EVENT, (event) => {
            const d = event?.data;
            if (d?.transferId !== undefined) {
                updateTransfer(d.transferId, {
                    status: d.success ? "success" : "error",
                    error: d.error,
                });
            }
        });

        return () => {
            offProgress();
            offComplete();
        };
    }, [updateTransfer]);

    return (
        <div className={cn("absolute inset-0 flex-col", isVisible ? "flex" : "hidden")}>
            {/* 终端区域 + 文件管理面板 */}
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
                {/* 终端区域 */}
                <div className="relative min-w-0 flex-1 overflow-hidden">
                    {sessions.map((session) => (
                        <TerminalInstance
                            key={session.id}
                            sessionId={session.id}
                            config={session.config}
                            isActive={session.id === activeSessionId}
                            disconnected={session.disconnected}
                        />
                    ))}
                </div>

                {/* 文件管理侧边面板 */}
                {isFilePanelVisible && activeSessionId && (
                    <ErrorBoundary>
                        <FilePanel sessionId={activeSessionId}/>
                    </ErrorBoundary>
                )}
            </div>

            {/* 代码片段面板（底部可折叠） */}
            {isSnippetPanelVisible && (
                <div className="h-48 shrink-0">
                    <ErrorBoundary>
                        <SnippetPanel sessionId={activeSessionId}/>
                    </ErrorBoundary>
                </div>
            )}

            {/* 代码片段面板切换按钮（浮动在终端区域右下角） */}
            <Button
                variant="outline"
                size="sm"
                onClick={toggleSnippetPanel}
                className={cn(
                    "absolute bottom-2 right-2 z-10 gap-1.5 shadow-md",
                    isSnippetPanelVisible && "bottom-[12.5rem]"
                )}
                title={t("snippet_toggle")}
            >
                <Code2 className="size-3.5"/>
                {t("snippet_title")}
                {isSnippetPanelVisible
                    ? <ChevronDown className="size-3"/>
                    : <ChevronUp className="size-3"/>
                }
            </Button>
        </div>
    );
}
