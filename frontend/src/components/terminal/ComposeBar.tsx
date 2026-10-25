// 命令草稿栏：先在本地编辑多行命令，确认后再发送到当前终端或所有已连接终端。
//
// 与终端直接键入的区别：
// - 不会把半成品/换行意外送到远端，适合粘贴复杂脚本前先校对
// - 历史只记录通过本栏发送的命令，不读取终端键入内容（避免记录密码）

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { sendSessionInput } from "@/lib/sessionTransport";
import {
    clearComposeHistory,
    composeHistoryKey,
    loadComposeHistory,
    pushComposeHistory,
} from "@/lib/commandHistory";
import { cn } from "@/lib/utils";

interface ComposeBarProps {
    sessionId: string | null;
}

export function ComposeBar({ sessionId }: ComposeBarProps) {
    const { t } = useTranslation("terminal");
    const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId));

    const [text, setText] = useState("");
    const [sendToAll, setSendToAll] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const endpoint = useMemo(
        () => (session ? composeHistoryKey(session.config) : null),
        [session]
    );
    const connected = session?.status === "connected";

    useEffect(() => {
        setHistory(loadComposeHistory(endpoint));
        setHistoryIndex(-1);
    }, [endpoint]);

    const send = () => {
        if (!sessionId || !connected) return;
        const content = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
        if (!content.trim()) return;

        const ids = sendToAll
            ? useSessionStore.getState().getActiveSessionIds()
            : [sessionId];
        for (const id of ids) {
            // 按会话类型路由：本地终端走 LocalShellService，SSH 走 SshService
            sendSessionInput(id, content + "\n").catch(console.error);
        }
        if (endpoint) {
            setHistory(pushComposeHistory(endpoint, content));
        }
        setText("");
        setHistoryIndex(-1);
    };

    // Ctrl+↑/↓ 在历史中回溯；普通 ↑/↓ 保留光标移动
    const moveHistory = (direction: -1 | 1) => {
        if (history.length === 0) return;
        const next = Math.max(-1, Math.min(history.length - 1, historyIndex + direction));
        setHistoryIndex(next);
        setText(next >= 0 ? history[next] : "");
        requestAnimationFrame(() => textareaRef.current?.focus());
    };

    const handleClearHistory = () => {
        if (!endpoint) return;
        clearComposeHistory(endpoint);
        setHistory([]);
        setHistoryIndex(-1);
    };

    return (
        <div className="flex h-full shrink-0 flex-col gap-1.5 border-t border-[var(--hairline)] bg-[var(--surface-1)] px-3 py-2">
            {/* 头部：标题 + 发送目标 + 历史清理 + 关闭 */}
            <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-[var(--fg-strong)]">
                    {t("compose_title")}
                </span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--fg-subtle)]">
                    {session ? `${session.config.username}@${session.config.host}` : t("compose_no_session")}
                </span>
                <div className="ml-auto flex items-center gap-1">
                    <div className="flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] p-0.5">
                        {[
                            { all: false, label: t("compose_target_current") },
                            { all: true, label: t("compose_target_all") },
                        ].map(({ all, label }) => (
                            <button
                                key={String(all)}
                                type="button"
                                onClick={() => setSendToAll(all)}
                                className={cn(
                                    "rounded-[var(--radius-sm)] px-2 py-0.5 text-[10.5px] transition-colors",
                                    sendToAll === all
                                        ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                        : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleClearHistory}
                        disabled={history.length === 0}
                        title={t("compose_clear_history")}
                    >
                        <Trash2 className="size-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => useUIStore.getState().setComposePanelVisible(false)}
                        title={t("compose_close")}
                    >
                        <X className="size-3.5" />
                    </Button>
                </div>
            </div>

            <div className="flex min-h-0 flex-1 items-stretch gap-2">
                <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={(e) => {
                        setText(e.target.value);
                        setHistoryIndex(-1);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        } else if (e.key === "ArrowUp" && e.ctrlKey) {
                            e.preventDefault();
                            moveHistory(-1);
                        } else if (e.key === "ArrowDown" && e.ctrlKey) {
                            e.preventDefault();
                            moveHistory(1);
                        }
                    }}
                    placeholder={t("compose_placeholder")}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none rounded-[var(--radius-sm)] border border-[var(--hairline)]
                               bg-[var(--surface-0)] px-2 py-1.5 font-mono text-xs text-[var(--fg-strong)]
                               outline-none placeholder:text-[var(--fg-subtle)] focus:border-[var(--hairline-strong)]"
                />
                <Button
                    size="sm"
                    onClick={send}
                    disabled={!connected || !text.trim()}
                    className="h-auto shrink-0 self-stretch px-3"
                    title={t("compose_send")}
                >
                    <Send className="size-3.5" />
                </Button>
            </div>

            {/* 最近发送的命令：点击回填，便于微调后重发 */}
            <div className="flex items-center gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
                <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">{t("compose_history")}</span>
                {history.length === 0 ? (
                    <span className="text-[10px] text-[var(--fg-subtle)]">{t("compose_history_empty")}</span>
                ) : (
                    history.slice(0, 8).map((item, idx) => (
                        <button
                            key={`${idx}-${item.slice(0, 24)}`}
                            type="button"
                            onClick={() => {
                                setText(item);
                                setHistoryIndex(idx);
                                requestAnimationFrame(() => textareaRef.current?.focus());
                            }}
                            title={item}
                            className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--hairline)]
                                       bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-muted)]
                                       transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--fg-strong)]"
                        >
                            {item.split("\n")[0].slice(0, 40)}
                        </button>
                    ))
                )}
                <span className="ml-auto shrink-0 text-[10px] text-[var(--fg-subtle)]">
                    {t("compose_hint")}
                </span>
            </div>
        </div>
    );
}
