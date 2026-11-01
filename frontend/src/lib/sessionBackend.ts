// 会话后端路由：把 kind 映射到具体的传输服务。
//
// SSH / 本地 shell / Telnet / 串口共用同一套事件通道（ssh:data / ssh:closed），
// 但输入、尺寸与关闭必须调用各自的服务。这里只依赖服务绑定，
// 对 SessionKind 使用 type-only 导入，避免与 sessionStore 形成运行时循环依赖。

import { SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { LocalShellService } from "../../bindings/terminator-desktop/backend/internal/services/local";
import { Service as NetConnService } from "../../bindings/terminator-desktop/backend/internal/services/netconn";
import type { SessionKind } from "@/store/sessionStore";

/** kind 缺省视为 SSH：旧数据与新增 SSH 会话都不写 kind */
export function isSshKind(kind?: SessionKind): boolean {
    return kind === undefined || kind === "ssh";
}

/** Telnet / 串口：走 NetConnService，但不支持 SFTP / 监控 / 端口转发 */
export function isNetConnKind(kind?: SessionKind): boolean {
    return kind === "telnet" || kind === "serial";
}

export function sendTransportInput(
    kind: SessionKind | undefined,
    sessionId: string,
    data: string,
): Promise<void> {
    if (kind === "local") return LocalShellService.Input(sessionId, data);
    if (isNetConnKind(kind)) return NetConnService.Input(sessionId, data);
    return SshService.Input(sessionId, data);
}

/** 原始字节通道：ZMODEM 等二进制协议使用，避免经 UTF-8 文本转码 */
export function sendTransportInputBase64(
    kind: SessionKind | undefined,
    sessionId: string,
    dataBase64: string,
): Promise<void> {
    if (kind === "local") return Promise.resolve();
    if (isNetConnKind(kind)) return NetConnService.InputBase64(sessionId, dataBase64);
    return SshService.InputBase64(sessionId, dataBase64);
}

export function resizeTransport(
    kind: SessionKind | undefined,
    sessionId: string,
    rows: number,
    cols: number,
): Promise<void> {
    if (kind === "local") return LocalShellService.Resize(sessionId, rows, cols);
    if (isNetConnKind(kind)) return NetConnService.Resize(sessionId, rows, cols);
    return SshService.Resize(sessionId, rows, cols);
}

export function closeTransport(kind: SessionKind | undefined, sessionId: string): Promise<void> {
    if (kind === "local") return LocalShellService.Close(sessionId);
    if (isNetConnKind(kind)) return NetConnService.Close(sessionId);
    return SshService.Disconnect(sessionId);
}
