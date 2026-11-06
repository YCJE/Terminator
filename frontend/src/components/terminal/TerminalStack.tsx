import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import { Code2, ChevronUp, ChevronDown, SquarePen, Zap, Server, SquareTerminal, Gauge } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";
import { TerminalInstance } from "@/components/terminal/TerminalInstance";
import { ComposeBar } from "@/components/terminal/ComposeBar";
import { SnippetPanel } from "@/components/terminal/SnippetPanel";
import { MonitorPanel } from "@/components/terminal/MonitorPanel";
import { FilePanel } from "@/components/sftp/FilePanel";
import { StatusBar } from "@/components/layout/StatusBar";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { isSshKind } from "@/lib/sessionBackend";
import { SFTP_PROGRESS_EVENT, SFTP_COMPLETE_EVENT } from "@/lib/sftpEvents";
import {
    computePaneLayout,
    isPaneSession,
    type PaneDivider,
    type PaneRect,
} from "@/lib/paneLayout";

interface TerminalStackProps {
    isVisible: boolean;
}

export function TerminalStack({isVisible}: TerminalStackProps) {
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const activeSessionKind = useSessionStore(
        (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.kind
    );
    // SFTP / 监控 / 端口转发依赖 SSH 客户端，本地/Telnet/串口均不提供
    const activeIsSsh = isSshKind(activeSessionKind);
    const layout = useSessionStore((s) => s.layout);
    const setPaneRatio = useSessionStore((s) => s.setPaneRatio);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const isMonitorPanelVisible = useUIStore((s) => s.isMonitorPanelVisible);
    const toggleMonitorPanel = useUIStore((s) => s.toggleMonitorPanel);
    const isSnippetPanelVisible = useUIStore((s) => s.isSnippetPanelVisible);
    const toggleSnippetPanel = useUIStore((s) => s.toggleSnippetPanel);
    const isComposePanelVisible = useUIStore((s) => s.isComposePanelVisible);
    const toggleComposePanel = useUIStore((s) => s.toggleComposePanel);
    const setQuickConnectOpen = useUIStore((s) => s.setQuickConnectOpen);
    const setActiveView = useUIStore((s) => s.setActiveView);
    const addLocalSession = useSessionStore((s) => s.addLocalSession);
    // 只订阅 updateTransfer 函数引用（不会随传输进度变化），避免高频重渲染
    const updateTransfer = useTransferStore((s) => s.updateTransfer);
    const { t } = useTranslation("terminal");

    // 仅当焦点落在当前布局的任一窗格时，才以多窗格布局渲染该组窗格。
    // 切换到其他标签后布局保留，回到该组任一窗格即恢复多窗格显示。
    const isPaneView = !!layout && !!activeSessionId && isPaneSession(layout, activeSessionId);
    const {leaves, dividers} = useMemo(
        () => computePaneLayout(isPaneView ? layout : null),
        [layout, isPaneView],
    );

    const splitContainerRef = useRef<HTMLDivElement>(null);
    const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
    // 拖动分隔条时记录目标节点与其矩形（百分比），移动事件按容器尺寸换算比例
    const dragStateRef = useRef<{
        nodeId: string;
        orientation: "row" | "column";
        rect: PaneRect;
    } | null>(null);

    // 布局从无到有时播放一次淡入，避免窗格突然弹出
    const prevPaneViewRef = useRef(isPaneView);
    const [splitEntering, setSplitEntering] = useState(false);
    useEffect(() => {
        if (prevPaneViewRef.current === isPaneView) return;
        prevPaneViewRef.current = isPaneView;
        if (!isPaneView) {
            setSplitEntering(false);
            return;
        }
        setSplitEntering(true);
        const timer = setTimeout(() => setSplitEntering(false), 260);
        return () => clearTimeout(timer);
    }, [isPaneView]);

    const handleDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>, divider: PaneDivider) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragStateRef.current = {
            nodeId: divider.nodeId,
            orientation: divider.orientation,
            rect: divider.rect,
        };
        setDraggingNodeId(divider.nodeId);
    };

    const handleDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragStateRef.current;
        if (!drag) return;
        // 指针捕获可能在 Alt+Tab、系统对话框或 pointercancel 时丢失，
        // 而 pointerup 又落在分隔条之外：此时 dragStateRef 会残留，
        // 之后鼠标只是经过分隔条（无按键的 pointermove 也会触发）
        // 就会不断改写分屏比例。无按键时立即结束拖拽。
        if (e.buttons === 0) {
            dragStateRef.current = null;
            setDraggingNodeId(null);
            return;
        }
        const container = splitContainerRef.current?.getBoundingClientRect();
        if (!container || container.width === 0 || container.height === 0) return;
        const fractionX = (e.clientX - container.left) / container.width;
        const fractionY = (e.clientY - container.top) / container.height;
        // 换算到分隔条所属子树的局部比例，嵌套分屏也能正确拖动
        const ratio = drag.orientation === "row"
            ? (fractionX - drag.rect.left / 100) / (drag.rect.width / 100)
            : (fractionY - drag.rect.top / 100) / (drag.rect.height / 100);
        setPaneRatio(drag.nodeId, ratio);
    };

    const handleDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        dragStateRef.current = null;
        setDraggingNodeId(null);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    // 每个窗格的绝对定位样式（百分比）：不参与布局的会话仍挂载但不可见
    const paneStyle = (sessionId: string): CSSProperties | undefined => {
        const rect = leaves.get(sessionId);
        if (!rect) return undefined;
        return {
            left: `${rect.left}%`,
            top: `${rect.top}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
        };
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
            if (d?.transferId === undefined) return;
            // 暂停后续传会复用同一个 transferID：上一次被取消的传输先结束，
            // 其"已取消"完成事件可能在续传进入 active 之后才送达。完成事件只带
            // transferID、无法区分是第几次执行，若照常写入终态，刚续传的任务就会被
            // 标成已取消，后续进度与成功结果全部被终态保护忽略。
            // 每个传输的绑定调用都会 await 并自行写入结果（含取消/失败），
            // 因此进行中的条目不需要依赖事件；其余状态（如 pausing）仍按事件落地。
            const current = useTransferStore.getState().transfers.find((t) => t.id === d.transferId);
            if (current?.status === "active") return;
            updateTransfer(d.transferId, {
                status: d.success ? "success" : "error",
                error: d.error,
            });
        });

        return () => {
            offProgress();
            offComplete();
        };
    }, [updateTransfer]);

    // 没有任何会话时展示工作区"海报位"：给出三条最常用入口，
    // 而不是留一块纯黑画布让用户自己找动作。
    if (sessions.length === 0) {
        return (
            <div className={cn("absolute inset-0 flex-col", isVisible ? "flex" : "hidden")}>
                <div className="terminal-empty">
                    <div className="terminal-empty__mark">
                        <img src="/appicon.png" alt="" className="size-6"/>
                    </div>
                    <h2 className="terminal-empty__title">{t("empty_title")}</h2>
                    <p className="terminal-empty__desc">{t("empty_desc")}</p>
                    <div className="terminal-empty__actions">
                        <button
                            type="button"
                            className="terminal-empty__primary"
                            onClick={() => setQuickConnectOpen(true)}
                        >
                            <Zap className="size-3.5"/>
                            {t("empty_quick_connect")}
                        </button>
                        <button
                            type="button"
                            className="terminal-empty__secondary"
                            onClick={() => setActiveView(ViewType.Hosts)}
                        >
                            <Server className="size-3.5"/>
                            {t("empty_browse_hosts")}
                        </button>
                        <button
                            type="button"
                            className="terminal-empty__secondary"
                            onClick={() => addLocalSession(t("local_terminal_title"))}
                        >
                            <SquareTerminal className="size-3.5"/>
                            {t("local_terminal_title")}
                        </button>
                    </div>
                    <div className="terminal-empty__hint">{t("empty_hint")}</div>
                </div>
            </div>
        );
    }

    return (
        <div className={cn("absolute inset-0 flex-col", isVisible ? "flex" : "hidden")}>
            {/* 终端区域 + 文件管理面板 */}
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
                {/* 终端区域（草稿栏作为其下方同列面板，不覆盖文件面板） */}
                <div className="relative flex min-w-0 flex-1 flex-col">
                    <div
                        ref={splitContainerRef}
                        className={cn(
                            "terminal-split-container relative min-h-0 flex-1 overflow-hidden",
                            draggingNodeId !== null && "is-split-dragging",
                            splitEntering && "is-split-enter"
                        )}
                    >
                        {sessions.map((session) => {
                            const paneRect = leaves.get(session.id);
                            // 布局内的窗格全部可见；不在布局内时只显示当前标签
                            const paneVisible = paneRect !== undefined
                                || (!isPaneView && session.id === activeSessionId);
                            return (
                                <TerminalInstance
                                    key={session.id}
                                    sessionId={session.id}
                                    config={session.config}
                                    sessionKind={session.kind}
                                    netConn={session.netConn}
                                    isVisible={paneVisible}
                                    isFocused={session.id === activeSessionId}
                                    disconnected={session.disconnected}
                                    onConnect={session.onConnect}
                                    reconnectNonce={session.reconnectNonce}
                                    attachOnMount={session.attached}
                                    className={paneRect ? "terminal-split-pane" : "inset-0"}
                                    style={paneRect ? paneStyle(session.id) : undefined}
                                />
                            );
                        })}

                        {/* 可拖拽分隔条：1px 发丝线 + 9px 命中区；嵌套布局逐层渲染 */}
                        {isPaneView && dividers.map((divider) => (
                            <div
                                key={divider.nodeId}
                                role="separator"
                                aria-orientation={divider.orientation === "row" ? "vertical" : "horizontal"}
                                className={cn(
                                    "terminal-split-divider",
                                    divider.orientation === "row" ? "is-vertical" : "is-horizontal",
                                    draggingNodeId === divider.nodeId && "is-dragging"
                                )}
                                style={divider.orientation === "row"
                                    ? {
                                        left: `${divider.rect.left + divider.rect.width * divider.ratio}%`,
                                        top: `${divider.rect.top}%`,
                                        height: `${divider.rect.height}%`,
                                        bottom: "auto",
                                    }
                                    : {
                                        top: `${divider.rect.top + divider.rect.height * divider.ratio}%`,
                                        left: `${divider.rect.left}%`,
                                        width: `${divider.rect.width}%`,
                                        right: "auto",
                                    }}
                                onPointerDown={(e) => handleDividerPointerDown(e, divider)}
                                onPointerMove={handleDividerPointerMove}
                                onPointerUp={handleDividerPointerUp}
                                onLostPointerCapture={() => {
                                    // 捕获丢失说明拖拽已不可继续，必须同时清掉拖拽状态，
                                    // 否则残留的 dragStateRef 会让后续 pointermove 继续改比例
                                    dragStateRef.current = null;
                                    setDraggingNodeId(null);
                                }}
                            />
                        ))}
                    </div>
                    {isComposePanelVisible && (
                        <div className="shrink-0" style={{height: "9.5rem"}}>
                            {/* key 绑定会话：切换标签时重建，避免 A 标签的草稿
                                被误发到 B 标签（或"发送到全部"时的其他会话） */}
                            <ComposeBar key={activeSessionId ?? "none"} sessionId={activeSessionId}/>
                        </div>
                    )}

                    {/* 草稿栏 / 代码片段面板切换按钮：锚定在终端列内，
                        避免文件面板展开时浮到 SFTP 列表上方 */}
                    <div
                        className="absolute right-2 z-10 flex flex-col items-end gap-2"
                        style={{bottom: isComposePanelVisible ? "calc(9.5rem + 8px)" : "8px"}}
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
                        {activeIsSsh && (
                            <button
                                type="button"
                                onClick={toggleMonitorPanel}
                                className={cn(
                                    "terminal-overlay-btn px-2.5 py-1.5 text-xs",
                                    isMonitorPanelVisible && "is-active"
                                )}
                                title={t("monitor_toggle")}
                            >
                                <Gauge className="size-3.5"/>
                                {t("monitor_title")}
                            </button>
                        )}
                    </div>
                </div>

                {/* 文件管理侧边面板（仅 SSH 会话提供 SFTP） */}
                {isFilePanelVisible && activeSessionId && activeIsSsh && (
                    <ErrorBoundary>
                        <FilePanel sessionId={activeSessionId}/>
                    </ErrorBoundary>
                )}

                {/* 服务器监控侧边面板：与文件面板互斥，共用同一条侧栏位置 */}
                {isMonitorPanelVisible && activeSessionId && activeIsSsh && (
                    <ErrorBoundary>
                        <MonitorPanel sessionId={activeSessionId}/>
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

            {/* 底部状态条：连接状态 / 端点 / 延迟 / 传输 / 终端属性 */}
            <StatusBar/>
        </div>
    );
}
