// SFTP 文件列表表格：展示 FileEntry[]，支持排序，双击进入目录

import { memo, useMemo, useState } from "react";
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

// 排序图标：纯函数组件，定义在组件外部避免每次 render 创建新类型
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
        <div className="flex h-full flex-col overflow-hidden">
            {/* 表头 */}
            <div
                className="grid items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground"
                style={{ gridTemplateColumns: "minmax(80px,1fr) 70px 80px 110px" }}
            >
                <button
                    type="button"
                    className="flex items-center gap-1 text-left hover:text-foreground"
                    onClick={() => toggleSort("name")}
                >
                    {t("name")} <SortIcon sortKey={sortKey} sortDir={sortDir} target="name" />
                </button>
                <button
                    type="button"
                    className="flex items-center gap-1 justify-end hover:text-foreground"
                    onClick={() => toggleSort("size")}
                >
                    {t("size")} <SortIcon sortKey={sortKey} sortDir={sortDir} target="size" />
                </button>
                <span className="truncate text-center">
                    {t("permissions")}
                </span>
                <button
                    type="button"
                    className="flex items-center gap-1"
                    onClick={() => toggleSort("modTime")}
                >
                    {t("modified")} <SortIcon sortKey={sortKey} sortDir={sortDir} target="modTime" />
                </button>
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
                                "grid cursor-default items-center gap-2 px-3 py-1.5 text-sm",
                                "transition-colors hover:bg-accent/60",
                                isSelected && "bg-accent"
                            )}
                            style={{ gridTemplateColumns: "minmax(80px,1fr) 70px 80px 110px" }}
                            title={entry.name}
                        >
                            <div className="flex min-w-0 items-center gap-2">
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
                            <span className="truncate text-right text-muted-foreground">
                                {entry.isDir ? "-" : formatFileSize(entry.size)}
                            </span>
                            <span className="truncate text-center font-mono text-xs text-muted-foreground">
                                {entry.mode || "-"}
                            </span>
                            <span className="truncate text-muted-foreground">
                                {formatDateTime(entry.modTime)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export const FileTable = memo(FileTableImpl);
