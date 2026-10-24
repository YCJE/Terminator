import { useEffect } from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import { Code2, ChevronUp, ChevronDown, SquarePen } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";
import { TerminalInstance } from "@/components/terminal/TerminalInstance";
import { ComposeBar } from "@/components/terminal/ComposeBar";
import { SnippetPanel } from "@/components/terminal/SnippetPanel";
import { FilePanel } from "@/components/sftp/FilePanel";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { SFTP_PROGRESS_EVENT, SFTP_COMPLETE_EVENT } from "@/lib/sftpEvents";

interface TerminalStackProps {
    isVisible: boolean;
}

export function TerminalStack({isVisible}: TerminalStackProps) {
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const activeSessionKind = useSessionStore(
        (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.kind
    );
    const split = useSessionStore((s) => s.split);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const isSnippetPanelVisible = useUIStore((s) => s.isSnippetPanelVisible);
    const toggleSnippetPanel = useUIStore((s) => s.toggleSnippetPanel);
    const isComposePanelVisible = useUIStore((s) => s.isComposePanelVisible);
    const toggleComposePanel = useUIStore((s) => s.toggleComposePanel);
    // 只订阅 updateTransfer 函数引用（不会随传输进度变化），避免高频重渲染
    const updateTransfer = useTransferStore((s) => s.updateTransfer);
    const { t } = useTranslation("terminal");

    // 仅当焦点落在分屏的两个窗格之一时，才以分屏布局显示该组窗格。
    // 切换到其他标签后分屏关系保留，回到任一窗格即恢复双栏。
    const isSplitView = !!split &&
        (activeSessionId === split.primaryId || activeSessionId === split.secondaryId);

    // 分屏窗格使用绝对定位各占一半；普通标签仍为整块覆盖
    const paneClass = (id: string): string => {
        if (!isSplitView || !split) return "inset-0";
        if (split.orientation === "row") {
            return id === split.primaryId
                ? "inset-y-0 left-0 right-1/2 border-r border-[var(--hairline)]"
                : "inset-y-0 left-1/2 right-0";
        }
        return id === split.primaryId
            ? "inset-x-0 top-0 bottom-1/2 border-b border-[var(--hairline)]"
            : "inset-x-0 top-1/2 bottom-0";
    };

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
                {/* 终端区域（草稿栏作为其下方同列面板，不覆盖文件面板） */}
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        {sessions.map((session) => {
                            const paneVisible = isSplitView
                                ? session.id === split?.primaryId || session.id === split?.secondaryId
                                : session.id === activeSessionId;
                            return (
                                <TerminalInstance
                                    key={session.id}
                                    sessionId={session.id}
                                    config={session.config}
                                    sessionKind={session.kind}
                                    isVisible={paneVisible}
                                    isFocused={session.id === activeSessionId}
                                    disconnected={session.disconnected}
                                    onConnect={session.onConnect}
                                    reconnectNonce={session.reconnectNonce}
                                    className={paneClass(session.id)}
                                />
                            );
                        })}
                    </div>
                    {isComposePanelVisible && (
                        <div className="shrink-0" style={{height: "9.5rem"}}>
                            <ComposeBar sessionId={activeSessionId}/>
                        </div>
                    )}
                </div>

                {/* 文件管理侧边面板（本地终端没有 SFTP） */}
                {isFilePanelVisible && activeSessionId && activeSessionKind !== "local" && (
                    <ErrorBoundary>
                        <FilePanel sessionId={activeSessionId}/>
                    </ErrorBoundary>
                )}
            </div>

            {/* 代码片段面板（底部可折叠） */}
            {isSnippetPanelVisible && (
                <div className="shrink-0" style={{ height: "var(--snippet-panel-height)" }}>
                    <ErrorBoundary>
                        <SnippetPanel sessionId={activeSessionId}/>
                    </ErrorBoundary>
                </div>
            )}

            {/* 草稿栏 / 代码片段面板切换按钮（浮动在终端区域右下角） */}
            <div
                className="absolute right-2 z-10 flex flex-col items-end gap-2"
                style={{
                    bottom: `calc(${isSnippetPanelVisible ? "var(--snippet-panel-height)" : "0px"} + ${
                        isComposePanelVisible ? "9.5rem" : "0px"
                    } + 8px)`,
                }}
            >
                <button
                    type="button"
                    onClick={toggleComposePanel}
                    className={cn(
                        "terminal-overlay-btn px-2.5 py-1.5 text-xs font-medium",
                        isComposePanelVisible && "text-primary"
                    )}
                    title={t("compose_toggle")}
                >
                    <SquarePen className="size-3.5"/>
                    {t("compose_title")}
                </button>
                <button
                    type="button"
                    onClick={toggleSnippetPanel}
                    className="terminal-overlay-btn px-2.5 py-1.5 text-xs font-medium"
                    title={t("snippet_toggle")}
                >
                    <Code2 className="size-3.5"/>
                    {t("snippet_title")}
                    {isSnippetPanelVisible
                        ? <ChevronDown className="size-3"/>
                        : <ChevronUp className="size-3"/>
                    }
                </button>
            </div>
        </div>
    );
}
