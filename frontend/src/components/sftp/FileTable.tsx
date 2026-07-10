// SFTP 文件列表表格：展示 FileEntry[]，支持排序，双击进入目录
// 虚拟滚动：仅渲染可见区域 + 上下缓冲行，支持万级文件列表
// 借鉴 Netcatty 的自建虚拟列表方案（二分查找可见区间）

import { memo, useMemo, useState, useRef, useEffect, useCallback } from "react";
import {
    Folder,
    FileText,
    FileSymlink,
    ChevronUp,
    ChevronDown,
    ChevronsUpDown,
    Loader2,
} from "lucide-react";
import type { FileEntry } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { formatFileSize, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

type SortKey = "name" | "size" | "modTime";
type SortDir = "asc" | "desc";

// 虚拟滚动参数
const ROW_HEIGHT = 32; // 每行高度（px），与 py-1.5 + text-sm 对应
const BUFFER_ROWS = 3; // 上下各多渲染的缓冲行数

function SortIcon({ sortKey, sortDir, target }: { sortKey: SortKey; sortDir: SortDir; target: SortKey }) {
    if (sortKey !== target) return <ChevronsUpDown className="size-3 text-muted-foreground/40" />;
    return sortDir === "asc"
        ? <ChevronUp className="size-3" />
        : <ChevronDown className="size-3" />;
}

interface FileTableProps {
    entries: FileEntry[];
    loading: boolean;
    onOpen: (entry: FileEntry) => void;
    onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
    filterText?: string;
    onScrollChange?: (scrollTop: number) => void;
    restoreScrollTop?: number;
}

function FileTableImpl({ entries, loading, onOpen, onContextMenu, filterText, onScrollChange, restoreScrollTop }: FileTableProps) {
    const { t } = useTranslation("sftp");
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [selectedName, setSelectedName] = useState<string | null>(null);

    // 容器宽度检测：根据宽度决定显示哪些列
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(400);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(400);

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((resizeEntries) => {
            for (const entry of resizeEntries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [loading, entries.length]);

    // 监听滚动容器尺寸变化
    // 依赖 loading 和 entries.length：loading 时组件提前返回不渲染 scrollRef，
    // entries 为空时同理，需要在恢复正常显示后重新挂载 observer
    useEffect(() => {
        if (!scrollRef.current) return;
        const observer = new ResizeObserver((resizeEntries) => {
            for (const entry of resizeEntries) {
                setViewportHeight(entry.contentRect.height);
            }
        });
        observer.observe(scrollRef.current);
        return () => observer.disconnect();
    }, [loading, entries.length]);

    // 目录切换时恢复滚动位置（而非总是重置为 0）
    useEffect(() => {
        const target = restoreScrollTop ?? 0;
        setScrollTop(target);
        if (scrollRef.current) {
            scrollRef.current.scrollTop = target;
        }
        // 仅在 entries 变化时执行，restoreScrollTop 此时已是目标值
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entries]);

    const showSize = containerWidth > 360;
    const showPerm = containerWidth > 480;
    const showTime = containerWidth > 600;

    const gridCols = [
        "minmax(0,1fr)",
        showSize ? "60px" : "0px",
        showPerm ? "80px" : "0px",
        showTime ? "100px" : "0px",
    ].join(" ");

    // 按搜索文本过滤
    const filtered = useMemo(() => {
        if (!filterText || !filterText.trim()) return entries;
        const q = filterText.toLowerCase().trim();
        return entries.filter((e) => e.name.toLowerCase().includes(q));
    }, [entries, filterText]);

    const sorted = useMemo(() => {
        const dirs = filtered.filter((e) => e.isDir);
        const files = filtered.filter((e) => !e.isDir);

        const cmp = (a: FileEntry, b: FileEntry) => {
            let result = 0;
            if (sortKey === "name") {
                result = a.name.localeCompare(b.name);
            } else if (sortKey === "size") {
                result = a.size - b.size;
            } else {
                result = (a.modTime || "").localeCompare(b.modTime || "");
            }
            return sortDir === "asc" ? result : -result;
        };

        return [...dirs.sort(cmp), ...files.sort(cmp)];
    }, [filtered, sortKey, sortDir]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    };

    // 虚拟滚动：计算可见区间
    const totalHeight = sorted.length * ROW_HEIGHT;
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
    const endIndex = Math.min(sorted.length, startIndex + visibleCount);
    const visibleItems = sorted.slice(startIndex, endIndex);
    const offsetY = startIndex * ROW_HEIGHT;

    const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const top = e.currentTarget.scrollTop;
        setScrollTop(top);
        onScrollChange?.(top);
    }, [onScrollChange]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("loading", { ns: "common", defaultValue: "..." })}
            </div>
        );
    }

    if (entries.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("empty_dir")}
            </div>
        );
    }

    // 有文件但搜索结果为空
    if (filtered.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("no_search_results")}
            </div>
        );
    }

    return (
        <div ref={containerRef} className="flex h-full flex-col overflow-hidden">
            {/* 表头 */}
            <div
                className="grid items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground overflow-hidden"
                style={{ gridTemplateColumns: gridCols }}
            >
                <button
                    type="button"
                    className="flex items-center gap-1 text-left hover:text-foreground min-w-0"
                    onClick={() => toggleSort("name")}
                >
                    <span className="truncate">{t("name")}</span> <SortIcon sortKey={sortKey} sortDir={sortDir} target="name" />
                </button>
                {showSize && (
                    <button
                        type="button"
                        className="flex items-center gap-1 justify-end hover:text-foreground"
                        onClick={() => toggleSort("size")}
                    >
                        <span className="truncate">{t("size")}</span> <SortIcon sortKey={sortKey} sortDir={sortDir} target="size" />
                    </button>
                )}
                {showPerm && (
                    <span className="truncate text-center">{t("permissions")}</span>
                )}
                {showTime && (
                    <button
                        type="button"
                        className="flex items-center gap-1 hover:text-foreground"
                        onClick={() => toggleSort("modTime")}
                    >
                        <span className="truncate">{t("modified")}</span> <SortIcon sortKey={sortKey} sortDir={sortDir} target="modTime" />
                    </button>
                )}
            </div>

            {/* 虚拟滚动列表 */}
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden"
                onScroll={onScroll}
            >
                {/* 撑高容器以产生正确的滚动条 */}
                <div style={{ height: totalHeight, position: "relative" }}>
                    {/* 偏移定位到可见区域 */}
                    <div style={{ transform: `translateY(${offsetY}px)` }}>
                        {visibleItems.map((entry) => {
                            const isSelected = entry.name === selectedName;
                            return (
                                <div
                                    key={entry.name}
                                    onClick={() => setSelectedName(entry.name)}
                                    onDoubleClick={() => onOpen(entry)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        onContextMenu(entry, e);
                                    }}
                                    className={cn(
                                        "grid cursor-default items-center gap-2 px-3 py-1.5 text-sm overflow-hidden",
                                        "transition-colors hover:bg-accent/60",
                                        isSelected && "bg-accent"
                                    )}
                                    style={{ gridTemplateColumns: gridCols, height: ROW_HEIGHT }}
                                    title={entry.name}
                                >
                                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                                        <span className="shrink-0">
                                            {entry.isDir ? (
                                                <Folder className="size-4 text-primary" />
                                            ) : entry.isSymlink ? (
                                                <FileSymlink className="size-4 text-muted-foreground" />
                                            ) : (
                                                <FileText className="size-4 text-muted-foreground" />
                                            )}
                                        </span>
                                        <span className={cn("truncate", entry.isDir && "font-medium")}>
                                            {entry.name}
                                        </span>
                                    </div>
                                    {showSize && (
                                        <span className="truncate text-right text-muted-foreground">
                                            {entry.isDir ? "-" : formatFileSize(entry.size)}
                                        </span>
                                    )}
                                    {showPerm && (
                                        <span className="truncate text-center font-mono text-xs text-muted-foreground">
                                            {entry.mode || "-"}
                                        </span>
                                    )}
                                    {showTime && (
                                        <span className="truncate text-muted-foreground">
                                            {formatDateTime(entry.modTime)}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

export const FileTable = memo(FileTableImpl);
