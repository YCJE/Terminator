// SFTP 传输进度队列：底部可折叠面板，展示所有传输任务的进度与状态
// 优化：selector 返回稳定引用，避免无限重渲染

import { memo, useState } from "react";
import {
    Upload,
    Download,
    ChevronDown,
    Check,
    X,
    Loader2,
    Trash2,
} from "lucide-react";
import { useTransferStore, type TransferItem } from "@/store/transferStore";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// 单个传输项：由父组件传入 item，配合 memo 做浅比较。
// 未变化的项在 store 更新时保持同一对象引用，因此不会重渲染；
// 早前版本在每行内部用 transfers.find() 取自身状态，N 行即 O(N²) 扫描。
const TransferRow = memo(function TransferRow({ item }: { item: TransferItem }) {
    const removeTransfer = useTransferStore((s) => s.removeTransfer);

    const percent = item.total > 0
        ? Math.min(100, Math.round((item.transferred / item.total) * 100))
        : 0;

    return (
        <div className="sftp-transfer-row group">
            <span className="shrink-0 text-[var(--fg-muted)]">
                {item.type === "upload"
                    ? <Upload className="size-3.5" />
                    : <Download className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">{item.filename}</span>
                    <span className="shrink-0 text-[0.625rem] text-[var(--fg-subtle)]">
                        {item.total > 0
                            ? `${formatFileSize(item.transferred)} / ${formatFileSize(item.total)}`
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
                                    : "bg-primary"
                        )}
                        style={{ width: `${item.status === "success" ? 100 : percent}%` }}
                    />
                </div>
                {item.status === "error" && item.error && (
                    <div className="mt-0.5 truncate text-[0.625rem] text-destructive" title={item.error}>
                        {item.error}
                    </div>
                )}
            </div>
            <span className="flex shrink-0 items-center">
                {item.status === "active" && <Loader2 className="size-3.5 animate-spin text-[var(--fg-muted)]" />}
                {item.status === "success" && <Check className="size-3.5 text-success" />}
                {item.status === "error" && <X className="size-3.5 text-destructive" />}
            </span>
            {item.status !== "active" && (
                <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={() => removeTransfer(item.id)}
                >
                    <X className="size-3.5" />
                </Button>
            )}
        </div>
    );
});

export function TransferQueue() {
    const { t } = useTranslation("sftp");
    // 订阅原始 transfers 数组引用（只在 store set 时变化）
    // 不用 .map()/.filter() 否则每次都返回新数组/新值导致无限重渲染
    const transfers = useTransferStore((s) => s.transfers);
    const clearCompleted = useTransferStore((s) => s.clearCompleted);
    const [collapsed, setCollapsed] = useState(false);

    const activeCount = transfers.filter((x) => x.status === "active").length;
    const hasTransfers = transfers.length > 0;

    return (
        <div className="sftp-transfers">
            <div className="flex items-center justify-between px-3 py-1.5">
                <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs font-medium text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-strong)]"
                    onClick={() => setCollapsed((c) => !c)}
                >
                    <ChevronDown className={cn("size-3.5 transition-transform", !collapsed && "rotate-180")} />
                    {t("transfers")}
                    {activeCount > 0 && (
                        <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-semibold text-primary">
                            {activeCount}
                        </span>
                    )}
                </button>
                {hasTransfers && (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={clearCompleted}
                    >
                        <Trash2 className="size-3.5" />
                    </Button>
                )}
            </div>
            {!collapsed && (
                <div className="max-h-44 overflow-y-auto px-2 pb-2">
                    {transfers.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-[var(--fg-subtle)]">
                            {t("no_transfers")}
                        </div>
                    ) : (
                        transfers.map((transfer) => (
                            <TransferRow key={transfer.id} item={transfer} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
