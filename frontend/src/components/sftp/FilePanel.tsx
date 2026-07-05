// SFTP 文件管理面板：FinalShell 风格的侧边面板，放在终端右侧
// 提供目录浏览、文件操作（增删改查）、上传/下载、拖拽上传、传输队列等能力

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowUp,
    RefreshCw,
    Upload,
    FolderPlus,
    ChevronRight,
    Download,
    Pencil,
    FileText,
    Lock,
    Trash2,
} from "lucide-react";
import { Dialogs } from "@wailsio/runtime";
import { toast } from "sonner";
import {
    ListDir,
    ReadFile,
    Mkdir,
    Remove,
    Rename,
    Chmod,
    UploadFile,
    DownloadFile,
    HomeDir,
    type FileEntry,
} from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { useTransferStore } from "@/store/transferStore";
import { FileTable } from "@/components/sftp/FileTable";
import { TransferQueue } from "@/components/sftp/TransferQueue";
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
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { cn } from "@/lib/utils";
import { handleAppError } from "@/lib/error";
import { useTranslation } from "react-i18next";

interface FilePanelProps {
    sessionId: string;
}

// 文件预览大小上限：1MB
const PREVIEW_LIMIT = 1024 * 1024;

// 路径拼接工具
function joinPath(base: string, name: string): string {
    if (base.endsWith("/")) return base + name;
    return `${base}/${name}`;
}

// 取父目录路径
function parentPath(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    if (idx <= 0) return "/";
    return trimmed.slice(0, idx);
}

// 取路径中的文件名
function basename(p: string): string {
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? p;
}

// 将权限字符串（数字或符号形式）转换为八进制字符串，用于权限编辑预填
function toOctal(mode: string): string {
    if (!mode) return "755";
    if (/^[0-7]+$/.test(mode)) return mode.replace(/^0+/, "") || "0";
    // 解析符号权限，例如 drwxr-xr-x
    const sym = mode.replace(/[^rwxstST-]/g, "");
    if (sym.length >= 9) {
        const perms = sym.slice(-9);
        const groups = [perms.slice(0, 3), perms.slice(3, 6), perms.slice(6, 9)];
        let octal = 0;
        groups.forEach((g) => {
            let n = 0;
            if (g[0] === "r") n += 4;
            if (g[1] === "w") n += 2;
            if (g[2] === "x" || g[2] === "s" || g[2] === "t") n += 1;
            octal = octal * 10 + n;
        });
        return String(octal).padStart(3, "0");
    }
    return "755";
}

export function FilePanel({ sessionId }: FilePanelProps) {
    const { t } = useTranslation("sftp");
    // 只订阅函数引用，不订阅整个 store，避免传输进度变化触发面板重渲染
    const addTransfer = useTransferStore((s) => s.addTransfer);
    const updateTransfer = useTransferStore((s) => s.updateTransfer);

    const [currentPath, setCurrentPath] = useState("/");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);

    // 右键菜单状态
    const [contextMenu, setContextMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);

    // 各类对话框状态
    const [mkdirOpen, setMkdirOpen] = useState(false);
    const [mkdirValue, setMkdirValue] = useState("");
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [renameTarget, setRenameTarget] = useState("");
    const [chmodOpen, setChmodOpen] = useState(false);
    const [chmodValue, setChmodValue] = useState("");
    const [chmodTarget, setChmodTarget] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState("");
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
    const [previewContent, setPreviewContent] = useState("");

    // 拖拽与面板宽度
    const [isDragOver, setIsDragOver] = useState(false);
    const [width, setWidth] = useState(360);

    // 加载指定目录的文件列表
    const loadDir = useCallback(async (path: string) => {
        setLoading(true);
        try {
            const list = await ListDir(sessionId, path);
            setCurrentPath(path);
            setEntries(list || []);
        } catch (err) {
            handleAppError(err);
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    // 初始化：sessionId 变化时重置状态并加载新主机的文件
    useEffect(() => {
        let cancelled = false;
        // 重置状态，避免显示上一个主机的文件
        setEntries([]);
        setCurrentPath("/");
        setLoading(true);
        HomeDir(sessionId)
            .then((home) => {
                if (cancelled) return;
                loadDir(home || "/");
            })
            .catch((err) => {
                if (cancelled) return;
                handleAppError(err);
                setLoading(false);
            });
        return () => { cancelled = true; };
    }, [sessionId, loadDir]);

    // 面包屑导航分段
    const crumbs = useMemo(() => {
        const parts = currentPath.split("/").filter(Boolean);
        const segs: { name: string; path: string }[] = [{ name: "/", path: "/" }];
        let acc = "";
        parts.forEach((p) => {
            acc += "/" + p;
            segs.push({ name: p, path: acc });
        });
        return segs;
    }, [currentPath]);

    // 双击条目：目录则进入，文件则预览
    const handleOpen = (entry: FileEntry) => {
        if (entry.isDir) {
            loadDir(joinPath(currentPath, entry.name));
        } else {
            handlePreview(entry);
        }
    };

    // 预览文件内容（限制 1MB）
    const handlePreview = async (entry: FileEntry) => {
        if (entry.size > PREVIEW_LIMIT) {
            toast.error(t("file_too_large"));
            return;
        }
        try {
            const content = await ReadFile(sessionId, joinPath(currentPath, entry.name));
            setPreviewEntry(entry);
            setPreviewContent(content ?? "");
            setPreviewOpen(true);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 开始上传单个本地文件到当前目录
    const startUpload = (localPath: string) => {
        if (!localPath) return;
        const name = basename(localPath);
        const remotePath = joinPath(currentPath, name);
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId,
            filename: name,
            type: "upload",
            transferred: 0,
            total: 0,
            status: "active",
        });
        UploadFile(sessionId, transferId, localPath, remotePath)
            .then(() => {
                updateTransfer(transferId, { status: "success" });
                toast.success(t("upload_success"));
                loadDir(currentPath);
            })
            .catch((err) => {
                updateTransfer(transferId, { status: "error", error: String(err?.message ?? err) });
                handleAppError(err);
            });
    };

    // 点击上传按钮：弹出系统文件选择框
    const handleUploadClick = async () => {
        try {
            const result = await Dialogs.OpenFile({
                Title: t("upload"),
                AllowsMultipleSelection: true,
            });
            const paths = Array.isArray(result) ? result : (result ? [result] : []);
            paths.forEach((p) => startUpload(p));
        } catch (err) {
            // 用户取消文件选择不是错误，静默忽略
            const msg = String(err?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) {
                handleAppError(err);
            }
        }
    };

    // 下载文件：弹出系统保存框
    const handleDownload = async (entry: FileEntry) => {
        const remotePath = joinPath(currentPath, entry.name);
        try {
            const localPath = await Dialogs.SaveFile({ Title: t("download"), Filename: entry.name });
            if (!localPath) return;
            const transferId = crypto.randomUUID();
            addTransfer({
                id: transferId,
                sessionId,
                filename: entry.name,
                type: "download",
                transferred: 0,
                total: entry.size,
                status: "active",
            });
            DownloadFile(sessionId, transferId, remotePath, localPath)
                .then(() => {
                    updateTransfer(transferId, { status: "success" });
                    toast.success(t("download_success"));
                })
                .catch((err) => {
                    updateTransfer(transferId, { status: "error", error: String(err?.message ?? err) });
                    handleAppError(err);
                });
        } catch (err) {
            handleAppError(err);
        }
    };

    // 新建文件夹
    const handleMkdir = async () => {
        const name = mkdirValue.trim();
        if (!name) return;
        try {
            await Mkdir(sessionId, joinPath(currentPath, name));
            setMkdirOpen(false);
            setMkdirValue("");
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 重命名
    const handleRename = async () => {
        const newName = renameValue.trim();
        if (!newName || !renameTarget) return;
        try {
            await Rename(sessionId, joinPath(currentPath, renameTarget), joinPath(currentPath, newName));
            setRenameOpen(false);
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 修改权限
    const handleChmod = async () => {
        if (!chmodTarget) return;
        const mode = parseInt(chmodValue, 8);
        if (isNaN(mode)) return;
        try {
            await Chmod(sessionId, joinPath(currentPath, chmodTarget), mode);
            setChmodOpen(false);
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 删除
    const handleDelete = async () => {
        if (!deleteTarget) return;
        try {
            await Remove(sessionId, joinPath(currentPath, deleteTarget));
            setDeleteOpen(false);
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    const goParent = () => {
        const p = parentPath(currentPath);
        if (p !== currentPath) loadDir(p);
    };

    // 拖拽调整面板宽度
    // 用 ref 存储监听器引用，组件卸载时兜底清理
    const resizeCleanupRef = useRef<(() => void) | null>(null);

    const startResize = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        const onMove = (ev: MouseEvent) => {
            const delta = startX - ev.clientX;
            const newWidth = Math.min(Math.max(startWidth + delta, 280), 760);
            setWidth(newWidth);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            resizeCleanupRef.current = null;
        };
        document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        resizeCleanupRef.current = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
        };
    };

    // 组件卸载时清理拖拽监听器
    useEffect(() => {
        return () => {
            if (resizeCleanupRef.current) {
                resizeCleanupRef.current();
            }
        };
    }, []);

    // 拖拽本地文件到面板上传
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        if (!isDragOver) setIsDragOver(true);
    };
    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragOver(false);
        }
    };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        files.forEach((f) => {
            // Wails webview 中拖入的外部文件可能暴露 path 属性
            const path = (f as File & { path?: string }).path;
            if (path) startUpload(path);
        });
    };

    return (
        <div
            className={cn(
                "relative flex h-full flex-col cursor-default border-l border-border bg-card",
                isDragOver && "ring-2 ring-inset ring-primary"
            )}
            style={{ width }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* 左侧拖拽调整宽度的把手 — 仅在 hover 时显示 cursor */}
            <div
                onMouseDown={startResize}
                className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize opacity-0 hover:opacity-100 hover:bg-primary/40 transition-opacity"
            />

            {/* 头部标题 */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-medium">{t("file_panel_title")}</span>
            </div>

            {/* 工具栏：返回上级 + 面包屑 + 操作按钮 */}
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={goParent}
                    title={t("parent_dir")}
                    disabled={currentPath === "/"}
                >
                    <ArrowUp className="size-4" />
                </Button>

                <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden">
                    {crumbs.map((seg, idx) => (
                        <div key={seg.path} className="flex shrink-0 items-center">
                            {idx > 0 && <ChevronRight className="size-3 text-muted-foreground/50" />}
                            <button
                                type="button"
                                onClick={() => loadDir(seg.path)}
                                className="max-w-32 truncate rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                                {seg.name}
                            </button>
                        </div>
                    ))}
                </div>

                <Button variant="ghost" size="icon-sm" onClick={() => loadDir(currentPath)} title={t("refresh")}>
                    <RefreshCw className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={handleUploadClick} title={t("upload")}>
                    <Upload className="size-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => { setMkdirValue(""); setMkdirOpen(true); }}
                    title={t("mkdir")}
                >
                    <FolderPlus className="size-4" />
                </Button>
            </div>

            {/* 当前完整路径 */}
            <div
                className="truncate border-b border-border bg-muted/20 px-3 py-1 text-[0.625rem] text-muted-foreground"
                title={currentPath}
            >
                {currentPath}
            </div>

            {/* 文件列表 */}
            <div className="flex-1 overflow-hidden">
                <FileTable
                    entries={entries}
                    loading={loading}
                    onOpen={handleOpen}
                    onContextMenu={(entry, e) => setContextMenu({ entry, x: e.clientX, y: e.clientY })}
                />
            </div>

            {/* 拖拽上传提示遮罩 */}
            {isDragOver && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5">
                    <div className="rounded-lg border-2 border-dashed border-primary/50 bg-background/80 px-6 py-4 text-sm font-medium text-primary">
                        {t("upload")}
                    </div>
                </div>
            )}

            {/* 传输队列 */}
            <TransferQueue />

            {/* 右键上下文菜单：用不可见触发器定位到鼠标坐标 */}
            {contextMenu && (
                <DropdownMenu open onOpenChange={(o) => !o && setContextMenu(null)}>
                    <DropdownMenuTrigger asChild>
                        <span
                            aria-hidden
                            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }}
                        />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={2} className="min-w-40">
                        {!contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => { handlePreview(contextMenu.entry); setContextMenu(null); }}>
                                <FileText className="size-4" /> {t("preview")}
                            </DropdownMenuItem>
                        )}
                        {!contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => { handleDownload(contextMenu.entry); setContextMenu(null); }}>
                                <Download className="size-4" /> {t("download")}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => { setRenameTarget(contextMenu.entry.name); setRenameValue(contextMenu.entry.name); setRenameOpen(true); setContextMenu(null); }}>
                            <Pencil className="size-4" /> {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setChmodTarget(contextMenu.entry.name); setChmodValue(toOctal(contextMenu.entry.mode)); setChmodOpen(true); setContextMenu(null); }}>
                            <Lock className="size-4" /> {t("chmod")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => { setDeleteTarget(contextMenu.entry.name); setDeleteOpen(true); setContextMenu(null); }}
                        >
                            <Trash2 className="size-4" /> {t("delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}

            {/* 新建文件夹对话框 */}
            <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("mkdir")}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={mkdirValue}
                        onChange={(e) => setMkdirValue(e.target.value)}
                        placeholder={t("mkdir_prompt")}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") handleMkdir(); }}
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMkdirOpen(false)}>{t("cancel", { ns: "common" })}</Button>
                        <Button onClick={handleMkdir}>{t("mkdir")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 重命名对话框 */}
            <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("rename")}</DialogTitle>
                        <DialogDescription>{renameTarget}</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        placeholder={t("rename_prompt")}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRenameOpen(false)}>{t("cancel", { ns: "common" })}</Button>
                        <Button onClick={handleRename}>{t("rename")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 权限对话框 */}
            <Dialog open={chmodOpen} onOpenChange={setChmodOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("chmod")}</DialogTitle>
                        <DialogDescription>{chmodTarget}</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={chmodValue}
                        onChange={(e) => setChmodValue(e.target.value)}
                        placeholder={t("chmod_prompt")}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") handleChmod(); }}
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setChmodOpen(false)}>{t("cancel", { ns: "common" })}</Button>
                        <Button onClick={handleChmod}>{t("chmod")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 文件预览对话框 */}
            <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{t("preview")} - {previewEntry?.name}</DialogTitle>
                    </DialogHeader>
                    <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                        {previewContent}
                    </pre>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPreviewOpen(false)}>{t("close", { ns: "common" })}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 删除确认弹窗 */}
            <ConfirmModal
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                onConfirm={handleDelete}
                title={t("delete")}
                description={t("delete_confirm", { name: deleteTarget })}
            />
        </div>
    );
}
