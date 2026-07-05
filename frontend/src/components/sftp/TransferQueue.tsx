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
import { useTransferStore } from "@/store/transferStore";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// 单个传输项：独立订阅自身状态，避免其他项更新时跟着重渲染
const TransferRow = memo(function TransferRow({ id }: { id: string }) {
    const item = useTransferStore((s) => s.transfers.find((t) => t.id === id));
    const removeTransfer = useTransferStore((s) => s.removeTransfer);

    if (!item) return null;

    const percent = item.total > 0
        ? Math.min(100, Math.round((item.transferred / item.total) * 100))
        : 0;

    return (
        <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40">
            <span className="shrink-0 text-muted-foreground">
                {item.type === "upload"
                    ? <Upload className="size-3.5" />
                    : <Download className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">{item.filename}</span>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                        {item.total > 0
                            ? `${formatFileSize(item.transferred)} / ${formatFileSize(item.total)}`
                            : formatFileSize(item.transferred)}
                    </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
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
                {item.status === "active" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
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
        <div className="shrink-0 border-t border-border bg-muted/20">
            <div className="flex items-center justify-between px-3 py-1.5">
                <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                        <div className="px-3 py-3 text-xs text-muted-foreground">
                            {t("no_transfers")}
                        </div>
                    ) : (
                        transfers.map((transfer) => (
                            <TransferRow key={transfer.id} id={transfer.id} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
