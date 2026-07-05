// SFTP 文件列表表格：展示 FileEntry[]，支持排序，双击进入目录
// 窄面板时优先显示文件名，大小/权限/时间列依次隐藏

import { memo, useMemo, useState, useRef, useEffect } from "react";
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

// 排序图标：定义在组件外部避免每次 render 创建新类型
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
}

function FileTableImpl({ entries, loading, onOpen, onContextMenu }: FileTableProps) {
    const { t } = useTranslation("sftp");
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [selectedName, setSelectedName] = useState<string | null>(null);

    // 容器宽度检测：根据宽度决定显示哪些列
    // 文件名始终显示，大小>400px 显示，权限>500px 显示，时间>600px 显示
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(400);

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    const showSize = containerWidth > 360;
    const showPerm = containerWidth > 480;
    const showTime = containerWidth > 600;

    // 动态生成 grid 模板列
    const gridCols = [
        "minmax(0,1fr)",  // 文件名：始终显示，占用剩余空间
        showSize ? "60px" : "0px",
        showPerm ? "80px" : "0px",
        showTime ? "100px" : "0px",
    ].join(" ");

    const sorted = useMemo(() => {
        const dirs = entries.filter((e) => e.isDir);
        const files = entries.filter((e) => !e.isDir);

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
    }, [entries, sortKey, sortDir]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    };

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

            {/* 列表 */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {sorted.map((entry) => {
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
                            style={{ gridTemplateColumns: gridCols }}
                            title={entry.name}
                        >
                            {/* 名称 + 图标 — 优先显示，占用全部剩余空间 */}
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
    );
}

export const FileTable = memo(FileTableImpl);
