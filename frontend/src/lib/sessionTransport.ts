// 会话传输路由：前端只面对统一的输入/尺寸接口，
// 由会话 kind 决定走 SSH / 本地 shell / Telnet / 串口。
// 终端事件本身共用同一数据通道，显示逻辑无需区分数据来源。

import { useSessionStore, type SessionKind } from "@/store/sessionStore";
import {
    resizeTransport,
    sendTransportInput,
    sendTransportInputBase64,
} from "@/lib/sessionBackend";

function getSessionKind(sessionId: string): SessionKind | undefined {
    return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.kind;
}

/**
 * 路由输入/尺寸操作。
 * 浮动窗口是独立 webview，它的 store 里没有会话记录，必须由调用方把
 * 组件自身的 kind 传进来；缺省时才回落到主窗口 store 的查询。
 */
export function sendSessionInput(sessionId: string, data: string, kind?: SessionKind): Promise<void> {
    return sendTransportInput(kind ?? getSessionKind(sessionId), sessionId, data);
}

export function sendSessionInputBase64(sessionId: string, dataBase64: string, kind?: SessionKind): Promise<void> {
    return sendTransportInputBase64(kind ?? getSessionKind(sessionId), sessionId, dataBase64);
}

export function resizeSession(sessionId: string, rows: number, cols: number, kind?: SessionKind): Promise<void> {
    return resizeTransport(kind ?? getSessionKind(sessionId), sessionId, rows, cols);
}
