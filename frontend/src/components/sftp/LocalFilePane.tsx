// 本地文件栏：双栏 SFTP 的左侧，只读浏览本机目录。
//
// 与远端文件列表复用同一个 FileTable（虚拟滚动、排序、多选），
// 条目拖动时写入 LOCAL_PATHS_MIME，由远端栏接管上传；
// 远端条目拖入本栏时写入 REMOTE_PATHS_MIME，由面板接管下载。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowUp,
    FolderOpen,
    FolderPlus,
    Home,
    Loader2,
    Pencil,
    RefreshCw,
    Send,
    Trash2,
    Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TextFileService } from "../../../bindings/terminator-desktop/backend/internal/services/fileio";
import type { LocalEntry } from "../../../bindings/terminator-desktop/backend/internal/services/fileio/models";
import type { FileEntry } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { FileTable } from "@/components/sftp/FileTable";
import { LOCAL_PATHS_MIME, REMOTE_PATHS_MIME, joinLocalPath } from "@/lib/remotePath";
import { handleAppError } from "@/lib/error";
import { cn } from "@/lib/utils";

const LOCAL_PATH_STORAGE = "terminator_local_browser_path";

interface LocalFilePaneProps {
    width: number;
    /** 与远端一致：是否显示隐藏文件 */
    showHidden: boolean;
    /** 把选中的本地文件上传到远端当前目录 */
    onUploadPaths: (paths: string[]) => void;
    /** 把远端路径下载到本地当前目录 */
    onDownloadRemotePaths: (remotePaths: string[], localDir: string) => void;
    /** 把选中的本地文件分发到多台已连接的服务器（目标由面板选择） */
    onDistributePaths: (paths: string[]) => void;
    /** 本地目录变化：供批量下载直接落到当前目录 */
    onPathChange: (path: string) => void;
}

export function LocalFilePane({
    width,
    showHidden,
    onUploadPaths,
    onDownloadRemotePaths,
    onDistributePaths,
    onPathChange,
}: LocalFilePaneProps) {
    const { t } = useTranslation("sftp");
    const [entries, setEntries] = useState<LocalEntry[]>([]);
    const [currentPath, setCurrentPath] = useState("");
    const [pathInput, setPathInput] = useState("");
    const [home, setHome] = useState("");
    const [parent, setParent] = useState("");
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [dropActive, setDropActive] = useState(false);
    // 右键菜单与本地写操作对话框（新建/重命名/删除）
    const [contextMenu, setContextMenu] = useState<{ name: string; path: string; isDir: boolean; x: number; y: number } | null>(null);
    const [mkdirOpen, setMkdirOpen] = useState(false);
    const [mkdirValue, setMkdirValue] = useState("");
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string; isDir: boolean } | null>(null);
    const [busy, setBusy] = useState(false);
    const loadIdRef = useRef(0);
    // 回调与当前路径用 ref 保存，避免父组件每次渲染都触发重新加载
    const onPathChangeRef = useRef(onPathChange);
    onPathChangeRef.current = onPathChange;
    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;

    const load = useCallback(async (target: string, fallbackToHome = false) => {
        const myId = ++loadIdRef.current;
        setLoading(true);
        try {
            const listing = await TextFileService.ListLocalDir(target);
            if (myId !== loadIdRef.current) return;
            if (!listing) throw new Error(t("local_read_failed"));
            const nextPath = listing.path ?? "";
            setEntries(listing.entries ?? []);
            setCurrentPath(nextPath);
            setPathInput(nextPath);
            setHome(listing.home ?? "");
            setParent(listing.parent ?? "");
            setTruncated(!!listing.truncated);
            try {
                localStorage.setItem(LOCAL_PATH_STORAGE, nextPath);
            } catch {
                // localStorage 不可用时仅影响下次启动的初始目录
            }
            onPathChangeRef.current(nextPath);
        } catch (err) {
            if (myId !== loadIdRef.current) return;
            // 记住的目录可能已被删除：自动回退到主目录，而不是让面板停在报错态
            if (fallbackToHome) {
                void load("", false);
                return;
            }
            handleAppError(err);
            setPathInput(currentPathRef.current);
        } finally {
            if (myId === loadIdRef.current) setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t]);

    useEffect(() => {
        let initial = "";
        try {
            initial = localStorage.getItem(LOCAL_PATH_STORAGE) ?? "";
        } catch {
            initial = "";
        }
        void load(initial, true);
    }, [load]);

    // FileTable 使用 FileEntry 结构：把本地条目的毫秒时间转成 ISO 字符串，
    // 权限列在窄栏下不会显示，留空即可。
    const fileEntries = useMemo<FileEntry[]>(
        () => entries.map((entry) => ({
            name: entry.name,
            size: entry.size,
            mode: "",
            modTime: entry.modified ? new Date(entry.modified).toISOString() : "",
            isDir: entry.isDir,
            isSymlink: false,
        })),
        [entries]
    );

    const visibleEntries = useMemo(
        () => (showHidden ? fileEntries : fileEntries.filter((entry) => !entry.name.startsWith("."))),
        [fileEntries, showHidden]
    );

    const selectedPaths = useMemo(
        () => entries.filter((entry) => selectedNames.has(entry.name)).map((entry) => entry.path),
        [entries, selectedNames]
    );

    const openEntry = (entry: FileEntry) => {
        if (!entry.isDir) return;
        const target = entries.find((item) => item.name === entry.name);
        if (target) void load(target.path);
    };

    const submitPath = () => {
        const target = pathInput.trim();
        if (target === currentPath) return;
        void load(target, false);
    };

    // 本地新建/重命名只接受纯名称：名称里带路径分隔符会让操作落到当前目录之外
    const validLocalName = (name: string) => {
        if (!name) return false;
        if (/[\\/]/.test(name)) {
            toast.error(t("local_name_invalid"));
            return false;
        }
        return true;
    };

    const handleMkdirLocal = async () => {
        const name = mkdirValue.trim();
        if (!currentPath || !validLocalName(name)) return;
        setBusy(true);
        try {
            await TextFileService.MkdirLocal(joinLocalPath(currentPath, name));
            setMkdirOpen(false);
            setMkdirValue("");
            void load(currentPath);
        } catch (err) {
            handleAppError(err);
        } finally {
            setBusy(false);
        }
    };

    const handleRenameLocal = async () => {
        const name = renameValue.trim();
        if (!renameTarget || !validLocalName(name)) return;
        // 名称没变时不发起请求，直接关闭对话框
        if (name === renameTarget.name) {
            setRenameOpen(false);
            setRenameTarget(null);
            return;
        }
        setBusy(true);
        try {
            await TextFileService.RenameLocal(renameTarget.path, joinLocalPath(currentPath, name));
            setRenameOpen(false);
            setRenameTarget(null);
            void load(currentPath);
        } catch (err) {
            handleAppError(err);
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteLocal = async () => {
        if (!deleteTarget) return;
        setBusy(true);
        try {
            // 目录删除走递归：确认框已明确提示会删除全部内容
            await TextFileService.RemoveLocal(deleteTarget.path, deleteTarget.isDir);
            setDeleteTarget(null);
            void load(currentPath);
        } catch (err) {
            handleAppError(err);
        } finally {
            setBusy(false);
        }
    };

    const handleDragStart = (entry: FileEntry, e: React.DragEvent, selected?: string[]) => {
        const names = selected && selected.length > 1 ? selected : [entry.name];
        // 用条目名回查真实路径：Windows 盘符与分隔符不能靠字符串拼接
        const paths = entries
            .filter((item) => names.includes(item.name))
            .map((item) => item.path);
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(LOCAL_PATHS_MIME, JSON.stringify(paths));
    };

    const handleDragOver = (e: React.DragEvent) => {
        // 本栏只接受来自远端列表的内部拖拽；其余拖拽交回面板处理
        e.stopPropagation();
        const types = Array.from(e.dataTransfer.types).map((type) => type.toLowerCase());
        if (!types.includes(REMOTE_PATHS_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropActive) setDropActive(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropActive(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
        const raw = e.dataTransfer.getData(REMOTE_PATHS_MIME);
        if (!raw || !currentPath) return;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (!Array.isArray(parsed)) return;
            const paths = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
            if (paths.length > 0) onDownloadRemotePaths(paths, currentPath);
        } catch {
            // 载荷不是合法 JSON 时忽略，不发起任何下载
        }
    };

    return (
        <div
            className={cn(
                "relative flex min-w-0 shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)]",
                dropActive && "ring-2 ring-inset ring-primary"
            )}
            style={{width}}
            data-file-drop-target
            data-drop-kind="local"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div className="sftp-bar">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void load(home || "")}
                    title={t("local_home")}
                >
                    <Home className="size-4"/>
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => parent && void load(parent)}
                    disabled={!parent}
                    title={t("parent_dir")}
                >
                    <ArrowUp className="size-4"/>
                </Button>
                <input
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            submitPath();
                        } else if (e.key === "Escape") {
                            setPathInput(currentPath);
                        }
                    }}
                    onBlur={() => setPathInput(currentPath)}
                    placeholder={t("local_path_placeholder")}
                    title={currentPath}
                    className="h-5 min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-[var(--fg-subtle)]"
                />
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void load(currentPath)}
                    title={t("refresh")}
                >
                    {loading ? <Loader2 className="size-4 animate-spin"/> : <RefreshCw className="size-4"/>}
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                        setMkdirValue("");
                        setMkdirOpen(true);
                    }}
                    title={t("mkdir")}
                >
                    <FolderPlus className="size-4"/>
                </Button>
                {/* 有选中项时才出现上传/分发入口，避免窄栏里挤占路径输入 */}
                {selectedPaths.length > 0 && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onUploadPaths(selectedPaths)}
                            title={t("local_upload_selected", {count: selectedPaths.length})}
                        >
                            <Upload className="size-4"/>
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onDistributePaths(selectedPaths)}
                            title={t("distribute_selected", {count: selectedPaths.length})}
                        >
                            <Send className="size-4"/>
                        </Button>
                    </>
                )}
            </div>

            {truncated && (
                <div className="border-b border-[var(--hairline)] px-3 py-1 text-[10px] text-[var(--warning)]">
                    {t("local_truncated")}
                </div>
            )}

            <div className="flex-1 overflow-hidden">
                <FileTable
                    entries={visibleEntries}
                    loading={loading}
                    dirKey={currentPath}
                    onOpen={openEntry}
                    onContextMenu={(entry, e) => {
                        // 用名称回查真实路径：Windows 盘符与分隔符不能靠字符串拼接
                        const target = entries.find((item) => item.name === entry.name);
                        if (!target) return;
                        setContextMenu({
                            name: target.name,
                            path: target.path,
                            isDir: target.isDir,
                            x: e.clientX,
                            y: e.clientY,
                        });
                    }}
                    onEntryDragStart={handleDragStart}
                    selectedNames={selectedNames}
                    onSelectionChange={(names) => setSelectedNames(new Set(names))}
                />
            </div>

            {dropActive && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5">
                    <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-primary/50 bg-[var(--surface-1)] px-4 py-3 text-xs text-primary">
                        <FolderOpen className="size-4"/>
                        {t("local_drop_download")}
                    </div>
                </div>
            )}

            {/* 右键菜单：上传当前项 / 重命名 / 删除 */}
            {contextMenu && (
                <DropdownMenu open onOpenChange={(o) => !o && setContextMenu(null)}>
                    <DropdownMenuTrigger asChild>
                        <span
                            aria-hidden
                            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }}
                        />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={2} className="min-w-36">
                        <DropdownMenuItem onClick={() => {
                            onUploadPaths([contextMenu.path]);
                            setContextMenu(null);
                        }}>
                            <Upload className="size-4"/> {t("upload")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                            onDistributePaths([contextMenu.path]);
                            setContextMenu(null);
                        }}>
                            <Send className="size-4"/> {t("distribute")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem onClick={() => {
                            setRenameTarget({ path: contextMenu.path, name: contextMenu.name });
                            setRenameValue(contextMenu.name);
                            setRenameOpen(true);
                            setContextMenu(null);
                        }}>
                            <Pencil className="size-4"/> {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem variant="destructive" onClick={() => {
                            setDeleteTarget({ path: contextMenu.path, name: contextMenu.name, isDir: contextMenu.isDir });
                            setContextMenu(null);
                        }}>
                            <Trash2 className="size-4"/> {t("delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}

            {/* 新建本地目录 */}
            <Dialog open={mkdirOpen} onOpenChange={(open) => !busy && setMkdirOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("mkdir")}</DialogTitle>
                        <DialogDescription className="break-all">{currentPath}</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={mkdirValue}
                        onChange={(e) => setMkdirValue(e.target.value)}
                        placeholder={t("mkdir_prompt")}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") void handleMkdirLocal(); }}
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMkdirOpen(false)}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button onClick={() => void handleMkdirLocal()} disabled={busy || !mkdirValue.trim()}>
                            {t("mkdir")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 重命名本地条目 */}
            <Dialog open={renameOpen} onOpenChange={(open) => !busy && setRenameOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("rename")}</DialogTitle>
                        <DialogDescription className="break-all">{renameTarget?.name}</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        placeholder={t("rename_prompt")}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") void handleRenameLocal(); }}
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRenameOpen(false)}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button onClick={() => void handleRenameLocal()} disabled={busy || !renameValue.trim()}>
                            {t("rename")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 删除本地条目：目录会递归删除全部内容，确认文案明确提示 */}
            <ConfirmModal
                isOpen={!!deleteTarget}
                onClose={() => !busy && setDeleteTarget(null)}
                onConfirm={() => void handleDeleteLocal()}
                title={t("delete")}
                description={deleteTarget
                    ? (deleteTarget.isDir
                        ? t("local_delete_dir_confirm", {name: deleteTarget.name})
                        : t("local_delete_file_confirm", {name: deleteTarget.name}))
                    : ""}
                confirmDisabled={busy}
            />
        </div>
    );
}
