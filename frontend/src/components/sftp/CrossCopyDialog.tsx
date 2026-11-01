// 跨服务器复制对话框：把远端文件/目录复制到另一台已连接服务器的指定目录。
//
// 只列出"其他"已连接的 SSH 会话（本会话内部移动直接用重命名即可）；
// 数据由后端在两个 SFTP 客户端之间流式搬运，不经过本地磁盘。
// 目标目录优先使用会话最近上报的 cwd（OSC 7），未知时异步读取主目录。

import { useEffect, useMemo, useState } from "react";
import { Loader2, Server } from "lucide-react";
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

interface CrossCopyDialogProps {
    open: boolean;
    /** 待复制的远端绝对路径 */
    paths: string[];
    /** 源会话：目标列表会排除它 */
    sourceSessionId: string;
    onClose: () => void;
    onConfirm: (target: { sessionId: string; dir: string }) => void;
}

export function CrossCopyDialog({
    open,
    paths,
    sourceSessionId,
    onClose,
    onConfirm,
}: CrossCopyDialogProps) {
    const { t } = useTranslation("sftp");
    const sessions = useSessionStore((s) => s.sessions);
    const [selected, setSelected] = useState<string>("");
    const [dir, setDir] = useState("");

    // 只考虑其他已连接的 SSH 会话：本地 shell 没有 SFTP，断开/连接中的无法写入
    const eligible = useMemo(
        () => sessions.filter((s) =>
            (s.kind ?? "ssh") === "ssh"
            && s.status === "connected"
            && s.id !== sourceSessionId),
        [sessions, sourceSessionId],
    );
    const eligibleKey = eligible.map((s) => s.id).join("|");

    // 打开时重置选择与目标目录：默认选第一个可用会话，目录取其 cwd 或主目录
    useEffect(() => {
        if (!open) return;
        const first = eligible[0];
        setSelected(first?.id ?? "");
        setDir(first?.cwd ?? "");

        let cancelled = false;
        if (first && !first.cwd) {
            SftpService.HomeDir(first.id)
                .then((home) => {
                    // 用户在等待期间手动输入过目录时不覆盖
                    if (!cancelled && home) setDir((prev) => prev || (home ?? ""));
                })
                .catch(() => {
                    // 读取主目录失败时留空，由用户填写；不阻塞对话框
                });
        }
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, eligibleKey]);

    // 切换目标会话时同步切换默认目录（沿用该会话的 cwd，未知则留空等待输入）
    const selectSession = (id: string) => {
        if (id === selected || !eligible.some((s) => s.id === id)) return;
        setSelected(id);
        const next = eligible.find((s) => s.id === id);
        setDir(next?.cwd ?? "");
        if (next && !next.cwd) {
            SftpService.HomeDir(next.id)
                .then((home) => { if (home) setDir((prev) => prev || (home ?? "")); })
                .catch(() => {});
        }
    };

    const targetDir = dir.trim();
    const canSubmit = !!selected && targetDir.length > 0 && paths.length > 0;

    // 待复制条目摘要：只列前 3 个，避免对话框被长列表撑开
    const summary = useMemo(() => {
        const names = paths.map((p) => p.split("/").filter(Boolean).pop() ?? p);
        const head = names.slice(0, 3).join(", ");
        const rest = names.length - 3;
        return rest > 0 ? `${head} … (+${rest})` : head;
    }, [paths]);

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("copy_to_server")}</DialogTitle>
                    <DialogDescription>
                        {t("copy_to_server_desc", { count: paths.length })}
                        {summary && (
                            <span className="mt-1 block break-all font-mono text-[11px] text-[var(--fg-subtle)]">
                                {summary}
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                {eligible.length === 0 ? (
                    <div className="rounded-lg border border-[var(--hairline)] px-3 py-4 text-center text-xs text-[var(--fg-subtle)]">
                        {t("copy_empty")}
                    </div>
                ) : (
                    <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
                        {eligible.map((session) => {
                            const active = selected === session.id;
                            return (
                                <button
                                    key={session.id}
                                    type="button"
                                    onClick={() => selectSession(session.id)}
                                    className={cn(
                                        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                                        active
                                            ? "border-primary/40 bg-primary/5"
                                            : "border-[var(--hairline)] hover:bg-[var(--surface-3)]"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "size-3 shrink-0 rounded-full border",
                                            active ? "border-primary bg-primary" : "border-[var(--hairline)]"
                                        )}
                                    />
                                    <Server className="size-3.5 shrink-0 text-[var(--fg-muted)]" />
                                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--fg-strong)]">
                                        {session.title || session.config.host}
                                    </span>
                                    <span className="shrink-0 truncate font-mono text-[10px] text-[var(--fg-subtle)]">
                                        {session.config.username}@{session.config.host}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {eligible.length > 0 && (
                    <div className="flex items-center gap-1.5 border-t border-[var(--hairline)] pt-3">
                        <span className="shrink-0 text-[12px] text-[var(--fg-muted)]">{t("copy_target_dir")}</span>
                        <Input
                            value={dir}
                            onChange={(e) => setDir(e.target.value)}
                            placeholder={t("copy_target_dir_placeholder")}
                            className="h-7 flex-1 font-mono text-[11px]"
                        />
                        {!targetDir && <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--fg-subtle)]" />}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>{t("cancel", { ns: "common" })}</Button>
                    <Button
                        onClick={() => onConfirm({ sessionId: selected, dir: targetDir })}
                        disabled={!canSubmit}
                    >
                        {t("copy_confirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
