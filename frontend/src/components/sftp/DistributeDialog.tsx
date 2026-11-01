// 多服务器分发对话框：把本地文件一次投递到多台已连接的 SSH 服务器。
//
// 只列出"其他"已连接的 SSH 会话（当前面板所属会话直接走上传即可，不在此列）；
// 目标目录优先使用会话最近上报的 cwd（OSC 7），未知时异步读取主目录。
// 冲突策略在提交前统一选择，避免逐文件弹窗打断批量操作。

import { useEffect, useMemo, useState } from "react";
import { CheckSquare, Loader2, Server, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { useSessionStore } from "@/store/sessionStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { localBasename } from "@/lib/remotePath";

/** 一次分发目标：会话 + 该会话上的目标目录 */
export interface DistributeTarget {
    sessionId: string;
    dir: string;
}

export type DistributePolicy = "overwrite" | "skip";

interface DistributeDialogProps {
    open: boolean;
    /** 待分发的本地文件/目录绝对路径 */
    paths: string[];
    /** 发起分发的会话（上传到本会话由文件面板自行处理） */
    sourceSessionId: string;
    onClose: () => void;
    onConfirm: (targets: DistributeTarget[], policy: DistributePolicy) => void;
}

export function DistributeDialog({
    open,
    paths,
    sourceSessionId,
    onClose,
    onConfirm,
}: DistributeDialogProps) {
    const { t } = useTranslation("sftp");
    const sessions = useSessionStore((s) => s.sessions);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dirs, setDirs] = useState<Record<string, string>>({});
    const [policy, setPolicy] = useState<DistributePolicy>("overwrite");

    // 只考虑其他已连接的 SSH 会话：本地 shell 没有 SFTP，断开/连接中的无法投递
    const eligible = useMemo(
        () => sessions.filter((s) =>
            (s.kind ?? "ssh") === "ssh"
            && s.status === "connected"
            && s.id !== sourceSessionId),
        [sessions, sourceSessionId],
    );
    const eligibleKey = eligible.map((s) => s.id).join("|");

    // 打开时重置选择与目标目录：先用会话已知的 cwd，缺失的再异步读取主目录
    useEffect(() => {
        if (!open) return;
        const ids = eligible.map((s) => s.id);
        setSelected(new Set(ids));
        setPolicy("overwrite");
        setDirs(() => {
            const next: Record<string, string> = {};
            eligible.forEach((s) => { next[s.id] = s.cwd ?? ""; });
            return next;
        });

        let cancelled = false;
        eligible.forEach((s) => {
            if (s.cwd) return;
            SftpService.HomeDir(s.id)
                .then((home) => {
                    // 用户在等待期间手动输入过目录时不覆盖
                    if (!cancelled && home) {
                        setDirs((prev) => ({ ...prev, [s.id]: prev[s.id] || (home ?? "") }));
                    }
                })
                .catch(() => {
                    // 读取主目录失败时留空，由用户填写；不阻塞对话框
                });
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, eligibleKey]);

    const toggle = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const targets = eligible
        .filter((s) => selected.has(s.id) && (dirs[s.id] ?? "").trim().length > 0)
        .map((s) => ({ sessionId: s.id, dir: (dirs[s.id] ?? "").trim() }));

    const canSubmit = targets.length > 0 && paths.length > 0;

    // 待分发文件摘要：只列前 3 个，避免对话框被长列表撑开
    const pathSummary = useMemo(() => {
        const names = paths.map((p) => localBasename(p));
        const head = names.slice(0, 3).join(", ");
        const rest = names.length - 3;
        return rest > 0 ? `${head} … (+${rest})` : head;
    }, [paths]);

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("distribute")}</DialogTitle>
                    <DialogDescription>
                        {t("distribute_desc", { count: paths.length })}
                        {pathSummary && (
                            <span className="mt-1 block break-all font-mono text-[11px] text-[var(--fg-subtle)]">
                                {pathSummary}
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                {eligible.length === 0 ? (
                    <div className="rounded-lg border border-[var(--hairline)] px-3 py-4 text-center text-xs text-[var(--fg-subtle)]">
                        {t("distribute_empty")}
                    </div>
                ) : (
                    <div className="flex max-h-[42vh] flex-col gap-1.5 overflow-y-auto">
                        {eligible.map((session) => {
                            const checked = selected.has(session.id);
                            return (
                                <div
                                    key={session.id}
                                    className={cn(
                                        "rounded-lg border px-2.5 py-2 transition-colors",
                                        checked
                                            ? "border-primary/40 bg-primary/5"
                                            : "border-[var(--hairline)]"
                                    )}
                                >
                                    <button
                                        type="button"
                                        onClick={() => toggle(session.id)}
                                        className="flex w-full items-center gap-2 text-left"
                                    >
                                        {checked
                                            ? <CheckSquare className="size-4 shrink-0 text-primary" />
                                            : <Square className="size-4 shrink-0 text-[var(--fg-subtle)]" />}
                                        <Server className="size-3.5 shrink-0 text-[var(--fg-muted)]" />
                                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--fg-strong)]">
                                            {session.title || session.config.host}
                                        </span>
                                        <span className="shrink-0 truncate font-mono text-[10px] text-[var(--fg-subtle)]">
                                            {session.config.username}@{session.config.host}
                                        </span>
                                    </button>
                                    {checked && (
                                        <div className="mt-1.5 flex items-center gap-1.5 pl-6">
                                            <Input
                                                value={dirs[session.id] ?? ""}
                                                onChange={(e) => setDirs((prev) => ({ ...prev, [session.id]: e.target.value }))}
                                                placeholder={t("distribute_target_dir")}
                                                className="h-6 flex-1 font-mono text-[11px]"
                                            />
                                            {!(dirs[session.id] ?? "") && (
                                                <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--fg-subtle)]" />
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="flex items-center justify-between gap-3 border-t border-[var(--hairline)] pt-3">
                    <span className="text-[12px] text-[var(--fg-muted)]">{t("distribute_policy")}</span>
                    <div className="flex items-center gap-1">
                        {(["overwrite", "skip"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setPolicy(value)}
                                className={cn(
                                    "rounded-md border px-2 py-1 text-[11px] transition-colors",
                                    policy === value
                                        ? "border-primary/50 bg-primary/10 text-primary"
                                        : "border-[var(--hairline)] text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                                )}
                            >
                                {value === "overwrite" ? t("distribute_overwrite") : t("distribute_skip")}
                            </button>
                        ))}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>{t("cancel", { ns: "common" })}</Button>
                    <Button onClick={() => onConfirm(targets, policy)} disabled={!canSubmit}>
                        {t("distribute_confirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
