// 会话传输路由：前端只面对统一的输入/尺寸/关闭接口，
// 由会话 kind 决定走 SSH 还是本地 shell。终端事件本身共用同一数据通道。

import { useSessionStore } from "@/store/sessionStore";
import { SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { LocalShellService } from "../../bindings/terminator-desktop/backend/internal/services/local";

export function isLocalSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.kind === "local";
}

export function sendSessionInput(sessionId: string, data: string): Promise<void> {
    return isLocalSession(sessionId)
        ? LocalShellService.Input(sessionId, data)
        : SshService.Input(sessionId, data);
}

export function resizeSession(sessionId: string, rows: number, cols: number): Promise<void> {
    return isLocalSession(sessionId)
        ? LocalShellService.Resize(sessionId, rows, cols)
        : SshService.Resize(sessionId, rows, cols);
}

export function closeSessionTransport(sessionId: string): Promise<void> {
    return isLocalSession(sessionId)
        ? LocalShellService.Close(sessionId)
        : SshService.Disconnect(sessionId);
}
