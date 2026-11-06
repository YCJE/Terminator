// 浮动终端窗口：把会话从主窗口移到独立窗口，或把窗口中的会话收回标签栏。
//
// 两个方向都不重建连接：会话仍由后端的 SSH / 本地终端服务持有，
// 主窗口移除标签时保留连接（keepConnection），新视图以附着模式挂载。

import { toast } from "sonner";
import i18n from "@/i18n";
import { Service as FloatingService } from "../../bindings/terminator-desktop/backend/internal/services/floating";
import type { Request } from "../../bindings/terminator-desktop/backend/internal/services/floating/models";
import { SSHConnectionConfig } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useSessionStore, type SessionKind, type TerminalSession } from "@/store/sessionStore";

/** 浮动窗口广播的收回请求载荷（字段名与 Go 侧 json 标签一致） */
export interface FloatingDockData {
    sessionId: string;
    title: string;
    kind: string;
    /** 来源主机 ID（工作区恢复、书签与端口转发作用域依赖它） */
    hostId?: string;
    config?: SSHConnectionConfig | null;
    /** true 表示后端会话仍在运行，主窗口直接附着；false 表示需要重新连接 */
    attach?: boolean;
}

/**
 * 把会话移入浮动窗口。
 * 成功后主窗口只移除视图（不关闭连接），由新窗口附着到同一会话。
 */
export async function popOutSession(session: TerminalSession, alwaysOnTop = false): Promise<void> {
    // 浮动窗口的后端只接管 SSH / 本地会话；Telnet 与串口没有可传递的连接参数
    if (session.kind === "telnet" || session.kind === "serial") {
        toast.error(i18n.t("terminal:float_unsupported"));
        return;
    }
    try {
        const request: Request = {
            sessionId: session.id,
            title: session.title,
            kind: session.kind ?? "ssh",
            // 主机归属随会话一起传递，收回标签栏时才能恢复
            hostId: session.hostId,
            // 本地终端没有 SSH 连接参数；SSH 会话带上完整路由（含跳板链与代理），
            // 供浮动窗口内的"重连"使用
            config: session.kind === "local" ? null : session.config,
            // 已连接的会话直接附着；断开/连接中的会话让新窗口重新建立连接
            attach: session.status === "connected" && !session.disconnected,
            width: 0,
            height: 0,
            alwaysOnTop,
        };
        await FloatingService.OpenFloatingTerminal(request);
        useSessionStore.getState().removeSession(session.id, {keepConnection: true});
    } catch (err) {
        console.error("打开浮动窗口失败:", err);
        toast.error(i18n.t("terminal:float_open_failed"));
    }
}

/** 把浮动窗口中的会话收回标签栏（由主窗口监听浮动窗口广播时调用） */
export function adoptDockedSession(data: FloatingDockData): void {
    if (!data?.sessionId) return;
    const kind: SessionKind = data.kind === "local" ? "local" : "ssh";
    const base = data.config ?? null;
    const config = new SSHConnectionConfig({
        ...(base ?? {}),
        id: data.sessionId,
        host: kind === "local" ? "local" : base?.host ?? "",
        port: kind === "local" ? 0 : base?.port ?? 22,
        username: kind === "local" ? "" : base?.username ?? "",
    });
    useSessionStore.getState().adoptSession({
        sessionId: data.sessionId,
        title: data.title,
        kind,
        hostId: data.hostId,
        config,
        attached: data.attach !== false,
    });
}
