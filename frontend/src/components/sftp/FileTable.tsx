// SFTP 文件列表表格：展示 FileEntry[]，支持排序，双击进入目录
// 优化：窄面板时优先显示文件名，隐藏次要列；用 React.memo 减少重渲染

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

interface FileTableProps {
    entries: FileEntry[];
    loading: boolean;
    /** 双击条目时触发（文件夹进入、文件预览由父组件决定） */
    onOpen: (entry: FileEntry) => void;
    /** 右键条目时触发，携带鼠标坐标用于定位菜单 */
    onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
}

function FileTableImpl({ entries, loading, onOpen, onContextMenu }: FileTableProps) {
    const { t } = useTranslation("sftp");
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [selectedName, setSelectedName] = useState<string | null>(null);

    // 排序：目录永远排在文件前面，组内按当前排序键排序
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

    // 渲染表头排序图标
    const SortIcon = ({ k }: { k: SortKey }) => {
        if (sortKey !== k) return <ChevronsUpDown className="size-3 text-muted-foreground/40" />;
        return sortDir === "asc"
            ? <ChevronUp className="size-3" />
            : <ChevronDown className="size-3" />;
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

    // 列布局：文件名 flex-grow 最小 80px，大小/权限/时间用固定窄宽
    // 窄面板时用 CSS @container 隐藏权限和修改时间列
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
                    {t("name")} <SortIcon k="name" />
                </button>
                <button
                    type="button"
                    className="flex items-center gap-1 justify-end hover:text-foreground"
                    onClick={() => toggleSort("size")}
                >
                    {t("size")} <SortIcon k="size" />
                </button>
                {/* 权限列：面板宽度 <340px 时隐藏 */}
                <span className="hidden truncate [@container(max-width:340px)]:hidden">
                    {t("permissions")}
                </span>
                {/* 修改时间列：面板宽度 <420px 时隐藏 */}
                <button
                    type="button"
                    className="hidden items-center gap-1 [@container(max-width:420px)]:flex"
                    onClick={() => toggleSort("modTime")}
                >
                    {t("modified")} <SortIcon k="modTime" />
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
                            {/* 名称 + 图标 — 优先显示，占用剩余空间 */}
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
                            {/* 大小 */}
                            <span className="truncate text-right text-muted-foreground">
                                {entry.isDir ? "-" : formatFileSize(entry.size)}
                            </span>
                            {/* 权限：窄面板隐藏 */}
                            <span className="hidden truncate font-mono text-xs text-muted-foreground [@container(max-width:340px)]:hidden">
                                {entry.mode || "-"}
                            </span>
                            {/* 修改时间：窄面板隐藏 */}
                            <span className="hidden truncate text-muted-foreground [@container(max-width:420px)]:block">
                                {formatDateTime(entry.modTime)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// React.memo 包裹：entries 引用不变时跳过重渲染（如传输进度更新不会触发文件列表重渲染）
export const FileTable = memo(FileTableImpl);
