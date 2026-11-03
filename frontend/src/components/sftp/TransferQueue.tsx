// SFTP 传输进度队列：底部可折叠面板，展示所有传输任务的进度与状态
// 优化：selector 返回稳定引用，避免无限重渲染

import { memo, useMemo, useState } from "react";
import {
    Upload,
    Download,
    Copy as CopyIcon,
    ChevronDown,
    Check,
    X,
    Ban,
    Loader2,
    Trash2,
    RotateCw,
    Pause,
    Play,
    Clock3,
} from "lucide-react";
import { useTransferStore, type TransferItem, type TransferStatus } from "@/store/transferStore";
import { cancelScheduledTransfer, scheduleTransfer } from "@/lib/transferScheduler";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { isTransferCanceled } from "@/lib/sftpEvents";

/** 剩余时间/耗时：小于 1 分钟显示秒，超过显示分秒。 */
function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes}m ${rest}s`;
}

function formatClock(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 排序权重：进行中置顶，排队次之，暂停再次，失败在成功之前
const STATUS_RANK: Record<TransferStatus, number> = {
    active: 0,
    queued: 1,
    pausing: 2,
    paused: 3,
    error: 4,
    success: 5,
};

// 单个传输项：由父组件传入 item，配合 memo 做浅比较。
// 未变化的项在 store 更新时保持同一对象引用，因此不会重渲染；
// 早前版本在每行内部用 transfers.find() 取自身状态，N 行即 O(N²) 扫描。
const TransferRow = memo(function TransferRow({ item, onRetry }: { item: TransferItem; onRetry?: (item: TransferItem) => void }) {
    const { t } = useTranslation("sftp");
    const removeTransfer = useTransferStore((s) => s.removeTransfer);
    const markPausing = useTransferStore((s) => s.markPausing);
    // 取消/续传请求已发出、后端尚未结束时禁用按钮，避免重复调用
    const [cancelling, setCancelling] = useState(false);
    const [resuming, setResuming] = useState(false);

    const percent = item.total > 0
        ? Math.min(100, Math.round((item.transferred / item.total) * 100))
        : 0;

    // 可续传/重试：普通上传下载需要本地与远端路径；
    // 跨服务器复制没有本地路径，需要源路径 + 目标会话 + 目标路径。
    const resumable = item.type === "copy"
        ? !!(item.sourcePath && item.targetSessionId && item.remotePath)
        : !!(item.localPath && item.remotePath);
    const retryable = item.type === "copy"
        ? resumable
        : !!(item.localPath && (item.remotePath || (item.archivePaths?.length ?? 0) > 0));

    const requestCancel = () => {
        // 排队中的任务还没调用后端，从调度队列移除即可；
        // 若刚好被调度器取出执行，则回退到后端取消接口。
        if (item.status === "queued") {
            if (!cancelScheduledTransfer(item.sessionId, item.id)) {
                SftpService.CancelTransfer(item.id).catch(() => {});
            }
            useTransferStore.getState().updateTransfer(item.id, {status: "error", cancelled: true});
            return;
        }
        if (cancelling) return;
        setCancelling(true);
        // 后端会推送一次失败完成事件，队列据此转为"已取消"状态。
        // 无论调用成功还是失败都复位 cancelling：事件可能因任务刚好结束、
        // 连接断开而丢失，只在 catch 里复位会让按钮永久禁用。
        // 必须显式 catch：任务已结束/会话已断开时该调用会 reject，
        // finally 派生出的 Promise 无人处理会变成未捕获的 rejection。
        SftpService.CancelTransfer(item.id)
            .catch(() => {})
            .finally(() => setCancelling(false));
    };

    const requestPause = () => {
        if (item.status !== "active") return;
        markPausing(item.id);
        SftpService.CancelTransfer(item.id).catch(() => {});
        // 兜底：若后端因已完成/连接已断等原因没有推送完成事件，
        // 2.5 秒后把"暂停中"落到"已暂停"，避免按钮永久转圈。
        setTimeout(() => {
            const current = useTransferStore.getState().transfers.find((x) => x.id === item.id);
            if (current?.status === "pausing") {
                useTransferStore.getState().updateTransfer(item.id, {status: "paused"});
            }
        }, 2500);
    };

    const requestResume = () => {
        if (resuming || item.status !== "paused" || !resumable) return;
        setResuming(true);
        // 续传也必须走调度器：直接调用后端时，用户连续点开多个暂停任务会绕过
        // 每会话 3 个的并发上限，把大量请求同时压到同一条 SSH 连接上。
        // 条目在轮到执行前保持 paused（不提前 resumeTransfer）；调度器按 id 去重，
        // 因此组件被卸载重挂后按钮再次被点也不会重复发起同一个传输。
        let cancelledWhileQueued = false;
        scheduleTransfer(
            item.sessionId,
            item.id,
            async () => {
                if (cancelledWhileQueued) return;
                useTransferStore.getState().resumeTransfer(item.id);
                // 续传必须沿用原始传输方式：压缩上传的 localPath 是目录，
                // 走普通 Upload 会把目录内容平铺到目标目录而不是还原成 <目录名>/…；
                // 打包下载没有单一 remotePath，只能按 archivePaths 重新打包。
                const run = item.type === "copy"
                    ? SftpService.CopyBetweenSessions(
                        item.sessionId, item.sourcePath!, item.targetSessionId!, item.remotePath!, item.id,
                    )
                    : item.type === "upload"
                        ? (item.archiveUpload
                            ? SftpService.UploadDirArchive(
                                item.sessionId, item.id, item.localPath!, item.remotePath!,
                            )
                            : SftpService.Upload(item.sessionId, item.id, item.localPath!, item.remotePath!))
                        : (item.archivePaths?.length
                            ? SftpService.DownloadArchive(
                                item.sessionId, item.id, item.archivePaths, item.localPath!,
                            )
                            : SftpService.Download(item.sessionId, item.id, item.remotePath!, item.localPath!));
                try {
                    await run;
                    useTransferStore.getState().updateTransfer(item.id, {status: "success"});
                } catch (err) {
                    useTransferStore.getState().updateTransfer(
                        item.id,
                        isTransferCanceled(err)
                            ? {status: "error", cancelled: true}
                            : {status: "error", error: String((err as Error)?.message ?? err)}
                    );
                } finally {
                    setResuming(false);
                }
            },
            () => {
                // 排队期间被取消（用户移除条目或会话关闭）：不要再发起后端传输
                cancelledWhileQueued = true;
                useTransferStore.getState().updateTransfer(item.id, {status: "error", cancelled: true});
                setResuming(false);
            },
        );
    };

    // 进度行下方的元信息：进行中显示速率/剩余时间，结束后显示耗时与完成时刻
    const meta = useMemo(() => {
        if (item.status === "active") {
            const parts: string[] = [];
            if (item.total > 0) {
                parts.push(`${formatFileSize(item.transferred)} / ${formatFileSize(item.total)}`);
            } else {
                parts.push(formatFileSize(item.transferred));
            }
            if (item.bytesPerSec && item.bytesPerSec > 0) {
                parts.push(`${formatFileSize(item.bytesPerSec)}/s`);
                if (item.total > item.transferred) {
                    parts.push(t("eta_label", {
                        time: formatDuration((item.total - item.transferred) / item.bytesPerSec),
                    }));
                }
            }
            return parts.join(" · ");
        }
        if (item.status === "queued") return t("queued");
        if (item.status === "pausing") return t("pausing");
        if (item.status === "paused") return t("paused");
        const parts: string[] = [];
        if (item.finishedAt) {
            parts.push(t("duration_label", {
                time: formatDuration((item.finishedAt - item.startedAt) / 1000),
            }));
            parts.push(formatClock(item.finishedAt));
        }
        return parts.join(" · ");
    }, [item.status, item.transferred, item.total, item.bytesPerSec, item.finishedAt, item.startedAt, t]);

    return (
        <div className="sftp-transfer-row group">
            <span className="shrink-0 text-[var(--fg-muted)]">
                {item.type === "upload"
                    ? <Upload className="size-3.5" />
                    : item.type === "copy"
                        ? <CopyIcon className="size-3.5" />
                        : <Download className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">{item.filename}</span>
                    <span className="shrink-0 text-[0.625rem] text-[var(--fg-subtle)]">
                        {item.status === "paused" || item.status === "pausing"
                            ? `${Math.round(percent)}%`
                            : item.total > 0
                                ? `${Math.round(percent)}%`
                                : formatFileSize(item.transferred)}
                    </span>
                </div>
                <div className="sftp-transfer-track mt-1">
                    <div
                        className={cn(
                            "h-full rounded-full transition-all",
                            item.status === "error"
                                ? "bg-destructive"
                                : item.status === "success"
                                    ? "bg-success"
                                    : item.status === "paused" || item.status === "pausing"
                                        ? "bg-[var(--warning)]"
                                        : item.status === "queued"
                                            ? "bg-[var(--fg-subtle)]"
                                            : "bg-primary"
                        )}
                        style={{ width: `${item.status === "success" ? 100 : percent}%` }}
                    />
                </div>
                {meta && (
                    <div className="mt-0.5 truncate text-[0.625rem] text-[var(--fg-subtle)]" title={meta}>
                        {meta}
                    </div>
                )}
                {item.status === "error" && (item.cancelled || item.error) && (
                    <div
                        className={cn(
                            "mt-0.5 truncate text-[0.625rem]",
                            item.cancelled ? "text-[var(--fg-subtle)]" : "text-destructive"
                        )}
                        title={item.cancelled ? t("canceled") : item.error}
                    >
                        {item.cancelled ? t("canceled") : item.error}
                    </div>
                )}
            </div>
            <span className="flex shrink-0 items-center gap-0.5">
                {item.status === "active" && (
                    <>
                        <Loader2 className="size-3.5 animate-spin text-[var(--fg-muted)]" />
                        {resumable && (
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                className="opacity-0 group-hover:opacity-100"
                                title={t("pause_transfer")}
                                onClick={requestPause}
                            >
                                <Pause className="size-3.5" />
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="opacity-0 group-hover:opacity-100"
                            title={t("cancel_transfer")}
                            disabled={cancelling}
                            onClick={requestCancel}
                        >
                            <X className="size-3.5" />
                        </Button>
                    </>
                )}
                {item.status === "queued" && (
                    <>
                        <Clock3 className="size-3.5 text-[var(--fg-subtle)]" />
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            className="opacity-0 group-hover:opacity-100"
                            title={t("cancel_transfer")}
                            onClick={requestCancel}
                        >
                            <X className="size-3.5" />
                        </Button>
                    </>
                )}
                {item.status === "pausing" && (
                    <Loader2 className="size-3.5 animate-spin text-[var(--warning)]" />
                )}
                {item.status === "paused" && (
                    <>
                        <Ban className="size-3.5 text-[var(--fg-subtle)]" />
                        {resumable && (
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                title={t("resume_transfer")}
                                disabled={resuming}
                                onClick={requestResume}
                            >
                                <Play className="size-3.5" />
                            </Button>
                        )}
                    </>
                )}
                {item.status === "success" && <Check className="size-3.5 text-success" />}
                {item.status === "error" && (
                    item.cancelled
                        ? <Ban className="size-3.5 text-[var(--fg-subtle)]" />
                        : <X className="size-3.5 text-destructive" />
                )}
                {/* 失败（非主动取消）且保留了原始路径时可一键重试 */}
                {item.status === "error" && !item.cancelled && onRetry && retryable && (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opacity-0 group-hover:opacity-100"
                        title={t("retry_transfer")}
                        onClick={() => onRetry(item)}
                    >
                        <RotateCw className="size-3.5" />
                    </Button>
                )}
            </span>
            {item.status !== "active" && item.status !== "pausing" && (
                <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={() => {
                        // 排队中的任务（含刚点续传、仍在等待槽位的 paused 条目）
                        // 被移除时，同步清掉调度队列里的条目，避免它稍后仍被启动
                        if (item.status === "queued" || item.status === "paused") {
                            cancelScheduledTransfer(item.sessionId, item.id);
                        }
                        removeTransfer(item.id);
                    }}
                >
                    <X className="size-3.5" />
                </Button>
            )}
        </div>
    );
});

export function TransferQueue({ sessionId, onRetry }: { sessionId?: string; onRetry?: (item: TransferItem) => void } = {}) {
    const { t } = useTranslation("sftp");
    // 订阅原始 transfers 数组引用（只在 store set 时变化）
    // 不用 .map()/.filter() 否则每次都返回新数组/新值导致无限重渲染
    const transfers = useTransferStore((s) => s.transfers);
    const clearCompleted = useTransferStore((s) => s.clearCompleted);
    const [collapsed, setCollapsed] = useState(false);

    // 只展示当前会话的传输：分屏/多标签时每个面板有自己的队列，
    // 否则 A 会话的面板会显示 B 会话的任务，清理按钮也会误删别人的记录。
    // 排序在渲染层做：进行中置顶，暂停次之，失败在成功之前；同组内按时间。
    const visibleTransfers = useMemo(() => {
        const list = sessionId ? transfers.filter((x) => x.sessionId === sessionId) : transfers;
        return [...list].sort((a, b) => {
            const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
            if (rank !== 0) return rank;
            if (a.status === "active" || a.status === "queued" || a.status === "pausing") {
                return a.startedAt - b.startedAt;
            }
            return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
        });
    }, [transfers, sessionId]);

    const activeCount = visibleTransfers.filter(
        (x) => x.status === "active" || x.status === "queued" || x.status === "pausing"
    ).length;
    const hasTransfers = visibleTransfers.length > 0;

    return (
        <div className="sftp-transfers">
            <div className="flex items-center justify-between px-3 py-1.5">
                <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-strong)]"
                    onClick={() => setCollapsed((c) => !c)}
                >
                    <ChevronDown className={cn("size-3.5 transition-transform", !collapsed && "rotate-180")} />
                    {t("transfers")}
                    {activeCount > 0 && (
                        <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.625rem] text-primary">
                            {activeCount}
                        </span>
                    )}
                </button>
                {hasTransfers && (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => clearCompleted(sessionId)}
                        title={t("clear_completed")}
                    >
                        <Trash2 className="size-3.5" />
                    </Button>
                )}
            </div>
            {!collapsed && (
                <div className="max-h-52 overflow-y-auto px-2 pb-2">
                    {visibleTransfers.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-[var(--fg-subtle)]">
                            {t("no_transfers")}
                        </div>
                    ) : (
                        visibleTransfers.map((transfer) => (
                            <TransferRow key={transfer.id} item={transfer} onRetry={onRetry} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
