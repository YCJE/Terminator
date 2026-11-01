// 批量执行页：在多台已连接的服务器上并发执行同一条命令，并汇总各主机输出。
//
// 执行由后端 batch 服务完成：每个会话单独开一个命令通道，互不影响，
// 也不会打扰用户正在使用的交互式终端。结果按选择顺序展示。

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2, Play, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Service as BatchService } from "../../../bindings/terminator-desktop/backend/internal/services/batch";
import { useSessionStore } from "@/store/sessionStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 单台主机的展示用执行状态 */
interface HostResult {
    sessionId: string;
    title: string;
    status: "running" | "success" | "failed";
    output: string;
    error?: string;
    durationMs?: number;
}

const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 3600;

function sessionTitle(session: { title?: string; config: { host: string } }): string {
    return session.title || session.config.host;
}

export function BatchExecPage() {
    const { t } = useTranslation(["batchExec", "common"]);
    const sessions = useSessionStore((s) => s.sessions);

    // 只能对已连接的 SSH 会话执行：本地终端没有后端 SSH 会话，断开的主机调用会失败
    const eligible = useMemo(
        () => sessions.filter((s) =>
            (s.kind ?? "ssh") === "ssh" && s.status === "connected" && !s.disconnected),
        [sessions],
    );
    const eligibleKey = eligible.map((s) => s.id).join("|");

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [command, setCommand] = useState("");
    const [timeoutText, setTimeoutText] = useState(String(DEFAULT_TIMEOUT));
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<HostResult[]>([]);

    // 默认全选当前可用主机；已失效的选中项（会话断开/关闭）自动剔除。
    // 用户主动清空后，可用主机集合变化时会重新全选，避免"新连上的主机没被选中"。
    useEffect(() => {
        setSelected((prev) => {
            const next = new Set([...prev].filter((id) => eligible.some((s) => s.id === id)));
            if (next.size === 0) eligible.forEach((s) => next.add(s.id));
            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eligibleKey]);

    const timeoutSeconds = useMemo(() => {
        const parsed = Number(timeoutText);
        if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT;
        return Math.min(MAX_TIMEOUT, Math.max(1, Math.floor(parsed)));
    }, [timeoutText]);

    const toggle = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleRun = async () => {
        const cmd = command.trim();
        if (!cmd) {
            toast.error(t("no_command"));
            return;
        }
        const targets = eligible.filter((s) => selected.has(s.id));
        if (targets.length === 0) {
            toast.error(t("no_target"));
            return;
        }
        if (running) return;

        setRunning(true);
        setResults(targets.map((s) => ({
            sessionId: s.id,
            title: sessionTitle(s),
            status: "running",
            output: "",
        })));

        try {
            const response = await BatchService.RunOnSessions(
                targets.map((s) => s.id), cmd, timeoutSeconds,
            );
            // 后端按入参顺序返回；仍按 sessionId 对齐，避免个别主机缺失导致标题错位
            const byId = new Map((response ?? []).map((item) => [item.sessionId, item]));
            const next: HostResult[] = targets.map((s) => {
                const item = byId.get(s.id);
                if (!item) {
                    return {
                        sessionId: s.id,
                        title: sessionTitle(s),
                        status: "failed",
                        output: "",
                        error: t("status_failed"),
                    };
                }
                return {
                    sessionId: s.id,
                    title: sessionTitle(s),
                    status: item.success ? "success" : "failed",
                    output: item.output ?? "",
                    error: item.error || undefined,
                    durationMs: item.durationMs,
                };
            });
            setResults(next);
            const failed = next.filter((item) => item.status === "failed").length;
            const summary = t("summary", {
                total: next.length,
                ok: next.length - failed,
                failed,
            });
            if (failed === 0) toast.success(summary);
            else toast.warning(summary);
        } catch (err) {
            const message = String((err as Error)?.message ?? err);
            setResults((prev) => prev.map((item) => item.status === "running"
                ? {...item, status: "failed", error: message}
                : item));
            toast.error(message);
        } finally {
            setRunning(false);
        }
    };

    const copyOutput = async (output: string) => {
        try {
            await navigator.clipboard.writeText(output);
            toast.success(t("copied"));
        } catch (err) {
            toast.error(String((err as Error)?.message ?? err));
        }
    };

    return (
        <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="page-header">
                <div className="toolbar-row">
                    <button
                        type="button"
                        className="toolbar-btn is-solid"
                        onClick={() => void handleRun()}
                        disabled={running || eligible.length === 0}
                        title={eligible.length === 0 ? t("target_empty") : undefined}
                    >
                        {running
                            ? <Loader2 className="size-4 animate-spin" />
                            : <Play className="size-4" />}
                        {t("run")}
                    </button>
                    <span className="ml-2 text-xs text-[var(--fg-muted)]">
                        {t("hosts_count", { count: selected.size })}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                        <span className="text-xs text-[var(--fg-muted)]">{t("timeout_label")}</span>
                        <Input
                            value={timeoutText}
                            onChange={(e) => setTimeoutText(e.target.value)}
                            className="h-7 w-16 text-center text-xs tabular-nums"
                            aria-label={t("timeout_label")}
                        />
                        <span className="text-xs text-[var(--fg-subtle)]">{t("timeout_unit")}</span>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setResults([])}
                            disabled={results.length === 0 || running}
                            title={t("clear_results")}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
                <div className="section-head is-first">{t("command_label")}</div>
                <textarea
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={t("command_placeholder")}
                    spellCheck={false}
                    rows={4}
                    className="w-full resize-y rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3 font-mono text-xs leading-relaxed outline-none focus:border-[var(--hairline-strong)]"
                    onKeyDown={(e) => {
                        // Ctrl/Cmd + Enter 执行，和终端习惯一致
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            e.preventDefault();
                            void handleRun();
                        }
                    }}
                />

                <div className="section-head flex items-center justify-between">
                    <span>{t("target_label")}</span>
                    <span className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelected(new Set(eligible.map((s) => s.id)))}
                            disabled={eligible.length === 0 || running}
                        >
                            {t("select_all")}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelected(new Set())}
                            disabled={selected.size === 0 || running}
                        >
                            {t("select_none")}
                        </Button>
                    </span>
                </div>

                {eligible.length === 0 ? (
                    <div className="rounded-lg border border-[var(--hairline)] px-3 py-4 text-center text-xs text-[var(--fg-subtle)]">
                        {t("target_empty")}
                    </div>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {eligible.map((session) => {
                            const active = selected.has(session.id);
                            return (
                                <button
                                    key={session.id}
                                    type="button"
                                    onClick={() => toggle(session.id)}
                                    disabled={running}
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                                        active
                                            ? "border-primary/50 bg-primary/10 text-primary"
                                            : "border-[var(--hairline)] text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]",
                                        running && "opacity-60",
                                    )}
                                    title={`${session.config.username}@${session.config.host}:${session.config.port}`}
                                >
                                    {active ? <Check className="size-3 shrink-0" /> : <Server className="size-3 shrink-0" />}
                                    <span className="max-w-44 truncate">{sessionTitle(session)}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                <div className="section-head">{t("results_title")}</div>
                {results.length === 0 ? (
                    <div className="rounded-lg border border-[var(--hairline)] px-3 py-6 text-center text-xs text-[var(--fg-subtle)]">
                        {t("results_empty")}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {results.map((item) => (
                            <div
                                key={item.sessionId}
                                className="overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)]"
                            >
                                <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-1.5">
                                    <Server className="size-3.5 shrink-0 text-[var(--fg-muted)]" />
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.title}</span>
                                    {item.durationMs !== undefined && (
                                        <span className="shrink-0 text-[10px] tabular-nums text-[var(--fg-subtle)]">
                                            {t("duration", { ms: item.durationMs })}
                                        </span>
                                    )}
                                    <span
                                        className={cn(
                                            "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
                                            item.status === "success"
                                                ? "bg-success/15 text-success"
                                                : item.status === "failed"
                                                    ? "bg-destructive/15 text-destructive"
                                                    : "bg-primary/15 text-primary",
                                        )}
                                    >
                                        {item.status === "running"
                                            ? t("status_running")
                                            : item.status === "success"
                                                ? t("status_success")
                                                : t("status_failed")}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        title={t("copy_output")}
                                        onClick={() => void copyOutput(item.output)}
                                        disabled={!item.output}
                                    >
                                        <Copy className="size-3.5" />
                                    </Button>
                                </div>
                                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                                    {item.output || t("output_empty")}
                                </pre>
                                {item.error && (
                                    <div className="break-all border-t border-[var(--hairline)] px-3 py-1.5 text-[10px] text-destructive">
                                        {item.error}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
