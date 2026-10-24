import type { TerminalSession } from "@/store/sessionStore";

/**
 * 展开代码片段中的变量占位符。
 *
 * 支持 `{{host}}`、`{{port}}`、`{{user}}` / `{{username}}`、`{{name}}`。
 * 未知占位符保持原样，便于用户发现拼写错误而不是静默发送空字符串。
 */
export function renderSnippetCommand(command: string, session?: TerminalSession | null): string {
    if (!session) return command;
    const values: Record<string, string> = {
        host: session.config.host,
        port: String(session.config.port),
        user: session.config.username,
        username: session.config.username,
        name: session.title,
    };
    return command.replace(/\{\{\s*(host|port|user|username|name)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}
