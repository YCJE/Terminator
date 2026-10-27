import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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

    // 分屏比例与拖拽状态：分隔条拖动时实时更新主窗格占比
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const [splitRatio, setSplitRatio] = useState(0.5);
    const [splitDragging, setSplitDragging] = useState(false);

    // 分屏对象变化（换窗格/换方向）时回到 1:1
    useEffect(() => {
        setSplitRatio(0.5);
    }, [split?.primaryId, split?.secondaryId, split?.orientation]);

    // 分屏进入动效：在布局阶段挂上动画类，保证首帧就是淡入起点而不会先闪一下；
    // 动画结束后摘掉类名，避免影响拖拽时逐帧写比例。
    const splitViewKey = split ? `${split.primaryId}|${split.secondaryId}|${split.orientation}` : "";
    const prevSplitViewKeyRef = useRef(splitViewKey);
    const [splitEntering, setSplitEntering] = useState(false);

    useLayoutEffect(() => {
        if (prevSplitViewKeyRef.current === splitViewKey) return;
        prevSplitViewKeyRef.current = splitViewKey;
        if (!splitViewKey) {
            setSplitEntering(false);
            return;
        }
        setSplitEntering(true);
        const timer = setTimeout(() => setSplitEntering(false), 260);
        return () => clearTimeout(timer);
    }, [splitViewKey]);

    // 主窗格按比例占据一侧，副窗格占据剩余空间；分隔条单独绘制
    const paneStyle = (id: string): CSSProperties | undefined => {
        if (!isSplitView || !split) return undefined;
        const percent = `${splitRatio * 100}%`;
        if (split.orientation === "row") {
            return id === split.primaryId
                ? { right: "auto", width: percent }
                : { left: percent };
        }
        return id === split.primaryId
            ? { bottom: "auto", height: percent }
            : { top: percent };
    };

    const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!split) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setSplitDragging(true);
    };

    const handleSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!splitDragging || !split) return;
        const rect = splitContainerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const next = split.orientation === "row"
            ? (e.clientX - rect.left) / rect.width
            : (e.clientY - rect.top) / rect.height;
        // 两侧各留 18% 最小宽度，避免窗格被拖成不可用尺寸
        setSplitRatio(Math.min(0.82, Math.max(0.18, next)));
    };

    const handleSplitPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        setSplitDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
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
                    <div
                        ref={splitContainerRef}
                        className={cn(
                            "terminal-split-container relative min-h-0 flex-1 overflow-hidden",
                            splitDragging && "is-split-dragging",
                            splitEntering && "is-split-enter"
                        )}
                    >
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
                                    className={cn(
                                        "inset-0",
                                        paneStyle(session.id) !== undefined && "terminal-split-pane"
                                    )}
                                    style={paneStyle(session.id)}
                                />
                            );
                        })}

                        {/* 可拖拽分隔条：1px 发丝线 + 9px 命中区，悬停/拖动时变为强调色 */}
                        {isSplitView && split && (
                            <div
                                // 换方向时重新挂载，重放分隔条淡入
                                key={`${split.primaryId}|${split.secondaryId}|${split.orientation}`}
                                role="separator"
                                aria-orientation={split.orientation === "row" ? "vertical" : "horizontal"}
                                className={cn(
                                    "terminal-split-divider",
                                    split.orientation === "row" ? "is-vertical" : "is-horizontal",
                                    splitDragging && "is-dragging"
                                )}
                                style={split.orientation === "row"
                                    ? { left: `${splitRatio * 100}%` }
                                    : { top: `${splitRatio * 100}%` }}
                                onPointerDown={handleSplitPointerDown}
                                onPointerMove={handleSplitPointerMove}
                                onPointerUp={handleSplitPointerUp}
                                onLostPointerCapture={() => setSplitDragging(false)}
                            />
                        )}
                    </div>
                    {isComposePanelVisible && (
                        <div className="shrink-0" style={{height: "9.5rem"}}>
                            {/* key 绑定会话：切换标签时重建，避免 A 标签的草稿
                                被误发到 B 标签（或"发送到全部"时的其他会话） */}
                            <ComposeBar key={activeSessionId ?? "none"} sessionId={activeSessionId}/>
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
                        "terminal-overlay-btn px-2.5 py-1.5 text-xs",
                        isComposePanelVisible && "is-active"
                    )}
                    title={t("compose_toggle")}
                >
                    <SquarePen className="size-3.5"/>
                    {t("compose_title")}
                </button>
                <button
                    type="button"
                    onClick={toggleSnippetPanel}
                    className={cn(
                        "terminal-overlay-btn px-2.5 py-1.5 text-xs",
                        isSnippetPanelVisible && "is-active"
                    )}
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
