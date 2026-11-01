// 终端区底部状态条：把"当前会话事实"集中在一行等宽小字上
// 参考 Tabby / VS Code 的 status bar：不参与交互主流程，只做状态与快捷入口。
// 延迟徽标从标题栏移到这里，避免顶栏同时堆叠会话状态与窗口操作两组信息。

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Radio } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { useTransferStore } from "@/store/transferStore";
import { useUIStore } from "@/store/uiStore";
import { LatencyBadge } from "@/components/layout/SessionStatusIndicators";
import { cn } from "@/lib/utils";
import { isSshKind } from "@/lib/sessionBackend";
import { TERMINAL_ENCODINGS, normalizeTerminalEncoding } from "@/lib/terminalEncoding";

export function StatusBar() {
    const { t } = useTranslation("terminal");
    // 只订阅激活会话与传输数组引用；进度更新会改变 transfers 引用，
    // 但下面用 useMemo 只取出"本会话进行中的数量"，不会每帧重算 DOM 结构。
    const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const transfers = useTransferStore((s) => s.transfers);
    const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);

    const activeTransfers = useMemo(() => {
        if (!session) return 0;
        return transfers.filter((x) => x.sessionId === session.id && x.status === "active").length;
    }, [transfers, session]);

    if (!session) return null;

    const kind = session.kind ?? "ssh";
    const isLocal = kind === "local";
    const isSsh = isSshKind(kind);
    const status = session.status;

    const statusLabel = status === "connected"
        ? t("status_connected")
        : status === "connecting"
            ? t("status_connecting")
            : t("status_disconnected");

    const statusTone = status === "connected"
        ? "is-success"
        : status === "connecting"
            ? "is-warning"
            : "is-error";

    // Telnet 用 host:port，串口用「设备名 波特率」，SSH 用 user@host:port
    const endpoint = isLocal
        ? t("local_terminal_title")
        : kind === "telnet"
            ? `${session.netConn?.host ?? session.config?.host ?? ""}:${session.netConn?.port ?? session.config?.port ?? 23}`
            : kind === "serial"
                ? `${session.netConn?.serial?.device ?? session.config?.host ?? ""} ${session.netConn?.serial?.baudRate ?? 115200}`
                : `${session.config?.username ? `${session.config.username}@` : ""}${session.config?.host ?? ""}:${session.config?.port ?? 22}`;
    const kindLabel = isLocal
        ? "LOCAL"
        : kind === "telnet"
            ? "TELNET"
            : kind === "serial"
                ? "SERIAL"
                : "SSH";
    // 会话编码：SSH 存在主机配置里，Telnet / 串口存在连接参数里；
    // 固定显示 UTF-8 会让选了 GBK 的用户误以为编码没生效
    const encodingValue = isLocal
        ? ""
        : kind === "telnet" || kind === "serial"
            ? session.netConn?.encoding
            : session.config?.encoding;
    const encodingLabel = TERMINAL_ENCODINGS.find(
        (item) => item.value === normalizeTerminalEncoding(encodingValue)
    )?.label ?? "UTF-8";

    return (
        <footer className="app-statusbar">
            <span className={cn("app-statusbar__seg", statusTone)} title={statusLabel}>
                <span className="app-statusbar__dot"/>
                {statusLabel}
            </span>

            <span className="app-statusbar__sep"/>

            <span className="app-statusbar__seg is-strong app-statusbar__endpoint" title={endpoint}>
                <span className="truncate">{endpoint}</span>
            </span>

            {/* 断开/连接中不做延迟采样：此时探测必然失败，只会显示占位符 */}
            {isSsh && status === "connected" && (
                <>
                    <span className="app-statusbar__sep"/>
                    <span className="app-statusbar__seg is-muted">
                        <LatencyBadge sessionId={session.id}/>
                    </span>
                </>
            )}

            {broadcastMode && !isLocal && (
                <>
                    <span className="app-statusbar__sep"/>
                    <span className="app-statusbar__seg is-warning" title={t("broadcast_on")}>
                        <Radio className="size-3"/>
                        {t("status_broadcast")}
                    </span>
                </>
            )}

            {activeTransfers > 0 && isSsh && (
                <>
                    <span className="app-statusbar__sep"/>
                    <span
                        role="button"
                        tabIndex={0}
                        className="app-statusbar__seg is-action is-strong"
                        title={t("status_transfers_tip")}
                        onClick={toggleFilePanel}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleFilePanel();
                            }
                        }}
                    >
                        <ArrowLeftRight className="size-3"/>
                        {t("status_transfers", { count: activeTransfers })}
                    </span>
                </>
            )}

            <span className="app-statusbar__spacer"/>

            <span className="app-statusbar__seg is-muted">{kindLabel}</span>
            <span className="app-statusbar__sep"/>
            <span className="app-statusbar__seg is-muted">{encodingLabel}</span>
        </footer>
    );
}
