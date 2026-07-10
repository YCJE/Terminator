// SFTP 文件管理面板：FinalShell 风格的侧边面板，放在终端右侧
// 提供目录浏览、文件操作（增删改查）、上传/下载、拖拽上传、传输队列等能力

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowUp,
    RefreshCw,
    Upload,
    FolderPlus,
    ChevronRight,
    ChevronDown,
    Columns,
    Folder,
    FolderOpen,
    Download,
    Pencil,
    FileText,
    Lock,
    Trash2,
    Search,
    X,
    FolderSearch,
    Loader2,
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
    SearchFiles,
    type FileEntry,
    type SearchResultEntry,
} from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { useTransferStore } from "@/store/transferStore";
import { useSessionStore } from "@/store/sessionStore";
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
import { formatFileSize } from "@/lib/format";
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
// 支持 setuid/setgid/sticky 特殊权限位
function toOctal(mode: string): string {
    if (!mode) return "755";
    if (/^[0-7]+$/.test(mode)) {
        // 去除前导零后补齐到 3 位，确保 chmod 正则校验通过
        return (mode.replace(/^0+/, "") || "0").padStart(3, "0");
    }
    // 解析符号权限，例如 drwsr-xr-x (4755) 或 drwxr-xr-t (1755)
    const sym = mode.replace(/[^rwxstST-]/g, "");
    if (sym.length >= 9) {
        const perms = sym.slice(-9);
        // 特殊位：第3位 s/S=setuid(4)，第6位 s/S=setgid(2)，第9位 t/T=sticky(1)
        let special = 0;
        if (perms[2] === "s" || perms[2] === "S") special += 4;
        if (perms[5] === "s" || perms[5] === "S") special += 2;
        if (perms[8] === "t" || perms[8] === "T") special += 1;

        const groups = [perms.slice(0, 3), perms.slice(3, 6), perms.slice(6, 9)];
        let octal = 0;
        groups.forEach((g) => {
            let n = 0;
            if (g[0] === "r") n += 4;
            if (g[1] === "w") n += 2;
            if (g[2] === "x" || g[2] === "s" || g[2] === "t") n += 1;
            octal = octal * 10 + n;
        });
        const base = String(octal).padStart(3, "0");
        return special > 0 ? `${special}${base}` : base;
    }
    return "755";
}

export function FilePanel({ sessionId }: FilePanelProps) {
    const { t } = useTranslation("sftp");
    // 只订阅函数引用，不订阅整个 store，避免传输进度变化触发面板重渲染
    const addTransfer = useTransferStore((s) => s.addTransfer);
    const updateTransfer = useTransferStore((s) => s.updateTransfer);
    // 订阅当前会话状态，仅在连接成功后才加载文件
    const sessionStatus = useSessionStore((s) => {
        const sess = s.sessions.find((x) => x.id === sessionId);
        return sess?.status || "connecting";
    });

    const [currentPath, setCurrentPath] = useState("/");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchText, setSearchText] = useState("");
    // 搜索模式："local" = 当前目录（即时过滤），"global" = 递归搜索整个系统
    const [searchMode, setSearchMode] = useState<"local" | "global">("local");
    const [searchResults, setSearchResults] = useState<SearchResultEntry[] | null>(null);
    const [searching, setSearching] = useState(false);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchIdRef = useRef(0);

    // 滚动位置记忆：path -> scrollTop
    // 用户浏览目录时保存滚动位置，返回上级时恢复到之前的浏览位置
    const scrollPositions = useRef<Map<string, number>>(new Map());
    const currentScrollTop = useRef(0);
    const [restoreScrollTop, setRestoreScrollTop] = useState(0);

    // ref 跟踪最新 currentPath，供异步回调使用（避免闭包陷阱）
    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;

    // ref 跟踪最新 dualPanel，供 loadDir 等异步回调使用
    const [dualPanel, setDualPanel] = useState(false);
    const dualPanelRef = useRef(dualPanel);
    dualPanelRef.current = dualPanel;

    // 右键菜单状态（fullPath 用于搜索结果中的绝对路径操作）
    const [contextMenu, setContextMenu] = useState<{ entry: FileEntry; x: number; y: number; fullPath?: string } | null>(null);

    // 解析右键菜单操作的文件路径：搜索结果用 fullPath，普通列表用 joinPath
    const resolveEntryPath = (entry: FileEntry) => {
        return contextMenu?.fullPath ?? joinPath(currentPath, entry.name);
    };
    // 存储右键菜单的完整路径（用于 rename/chmod/delete 等对话框操作）
    const contextMenuPathRef = useRef<string | null>(null);

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

    // 双面板模式：左侧目录树 + 右侧文件列表
    const [treeWidth, setTreeWidth] = useState(240);
    // 目录树展开状态：path -> 是否展开（根目录默认展开）
    const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({ "/": true });
    // 目录树子节点缓存：path -> 子目录列表（仅目录，文件已过滤）
    const [treeChildren, setTreeChildren] = useState<Record<string, FileEntry[]>>({});

    // 请求序列号，防止快速切换目录时的竞态条件
    const loadIdRef = useRef(0);

    // 加载目录树的子节点（仅目录），用于双面板左侧导航
    const loadTreeChildren = useCallback(async (path: string) => {
        const myId = loadIdRef.current;
        try {
            const list = await ListDir(sessionId, path);
            if (myId !== loadIdRef.current) return; // 会话已切换，丢弃旧数据
            const dirs = (list || []).filter((e) => e.isDir);
            setTreeChildren((prev) => ({ ...prev, [path]: dirs }));
        } catch {
            if (myId !== loadIdRef.current) return;
            // 静默处理树节点加载错误，不打断文件列表操作
        }
    }, [sessionId]);

    // 加载指定目录的文件列表（带竞态保护 + 滚动位置记忆）
    const loadDir = useCallback(async (path: string) => {
        // 保存当前目录的滚动位置，以便返回时恢复
        scrollPositions.current.set(currentPathRef.current, currentScrollTop.current);
        // 设置目标目录的恢复位置（首次访问为 0）
        setRestoreScrollTop(scrollPositions.current.get(path) ?? 0);
        // 清空搜索文本和结果
        setSearchText("");
        setSearchResults(null);

        const myId = ++loadIdRef.current;
        setLoading(true);
        try {
            const list = await ListDir(sessionId, path);
            if (myId !== loadIdRef.current) return;
            setCurrentPath(path);
            setEntries(list || []);
            if (dualPanelRef.current) {
                loadTreeChildren(path);
            }
        } catch (err) {
            if (myId !== loadIdRef.current) return;
            handleAppError(err);
        } finally {
            if (myId === loadIdRef.current) setLoading(false);
        }
    }, [sessionId, loadTreeChildren]);

    // 初始化：sessionId 变化或会话状态变为 connected 时加载文件
    useEffect(() => {
        // 会话未连接时不加载，避免 SSH 连接建立前调用 SFTP 导致 "session not found"
        if (sessionStatus !== "connected") return;
        let cancelled = false;
        // 递增 loadIdRef 使旧会话的在途 loadDir 请求失效
        const initId = ++loadIdRef.current;
        // 重置状态，避免显示上一个主机的文件
        setEntries([]);
        setCurrentPath("/");
        setLoading(true);
        // 重置目录树状态，避免残留旧主机的目录结构
        setTreeChildren({});
        setTreeExpanded({ "/": true });
        HomeDir(sessionId)
            .then((home) => {
                if (cancelled) return;
                // 用户在 HomeDir 期间已手动导航，不覆盖
                if (loadIdRef.current !== initId) return;
                loadDir(home || "/");
            })
            .catch((err) => {
                if (cancelled) return;
                handleAppError(err);
                setLoading(false);
            });
        return () => { cancelled = true; };
    }, [sessionId, sessionStatus, loadDir]);

    // 双面板模式同步：开启时或当前路径变化时，自动展开并加载当前路径的祖先目录
    useEffect(() => {
        if (!dualPanel) return;
        // 构建当前路径的所有祖先路径，全部展开
        const parts = currentPath.split("/").filter(Boolean);
        const toExpand: Record<string, boolean> = { "/": true };
        let acc = "";
        parts.forEach((p) => {
            acc += "/" + p;
            toExpand[acc] = true;
        });
        setTreeExpanded((prev) => ({ ...prev, ...toExpand }));
        // 懒加载根目录及所有祖先目录的子节点
        loadTreeChildren("/");
        let path = "";
        parts.forEach((p) => {
            path += "/" + p;
            loadTreeChildren(path);
        });
    }, [dualPanel, currentPath, loadTreeChildren]);

    // 展开/折叠目录树节点（首次展开时懒加载子目录）
    const toggleTreeNode = useCallback((path: string) => {
        const willExpand = !treeExpanded[path];
        if (willExpand && !treeChildren[path]) {
            loadTreeChildren(path);
        }
        setTreeExpanded((prev) => ({ ...prev, [path]: willExpand }));
    }, [treeExpanded, treeChildren, loadTreeChildren]);

    // 扁平化可见树节点列表（DFS 遍历，带层级深度用于缩进）
    const visibleTreeNodes = useMemo(() => {
        const nodes: { path: string; name: string; depth: number; expanded: boolean }[] = [];
        const traverse = (path: string, name: string, depth: number) => {
            const expanded = !!treeExpanded[path];
            nodes.push({ path, name, depth, expanded });
            if (expanded) {
                const children = treeChildren[path];
                if (children) {
                    children.forEach((child) => {
                        traverse(joinPath(path, child.name), child.name, depth + 1);
                    });
                }
            }
        };
        traverse("/", "/", 0);
        return nodes;
    }, [treeExpanded, treeChildren]);

    // 拖拽调整左侧目录树面板宽度
    const treeResizeCleanupRef = useRef<(() => void) | null>(null);

    const startTreeResize = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = treeWidth;
        const onMove = (ev: MouseEvent) => {
            const delta = ev.clientX - startX;
            const newWidth = Math.min(Math.max(startWidth + delta, 160), 480);
            setTreeWidth(newWidth);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            treeResizeCleanupRef.current = null;
        };
        document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        treeResizeCleanupRef.current = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
        };
    };

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
        // 显式检查 size 是否为有效数字，undefined/null 时拒绝预览
        if (typeof entry.size !== "number" || entry.size > PREVIEW_LIMIT) {
            toast.error(t("file_too_large"));
            return;
        }
        try {
            const path = resolveEntryPath(entry);
            const content = await ReadFile(sessionId, path);
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
        const uploadDir = currentPath; // 捕获上传目录
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
                // 仅当用户仍在上传目录时刷新，避免跳转
                if (currentPathRef.current === uploadDir) {
                    loadDir(uploadDir);
                }
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
            const msg = String((err as Error)?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) {
                handleAppError(err);
            }
        }
    };

    // 下载文件：弹出系统保存框
    const handleDownload = async (entry: FileEntry) => {
        const remotePath = resolveEntryPath(entry);
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
            // 搜索结果用 fullPath，普通列表用 joinPath
            const oldPath = contextMenuPathRef.current ?? joinPath(currentPath, renameTarget);
            const newPath = contextMenuPathRef.current
                ? joinPath(parentPath(contextMenuPathRef.current), newName)
                : joinPath(currentPath, newName);
            await Rename(sessionId, oldPath, newPath);
            setRenameOpen(false);
            contextMenuPathRef.current = null;
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 修改权限
    const handleChmod = async () => {
        if (!chmodTarget) return;
        // 严格校验八进制权限值（3-4位 0-7 数字）
        if (!/^[0-7]{3,4}$/.test(chmodValue)) {
            toast.error(t("invalid_chmod", {ns: "errors"}));
            return;
        }
        const mode = parseInt(chmodValue, 8);
        try {
            await Chmod(sessionId, contextMenuPathRef.current ?? joinPath(currentPath, chmodTarget), mode);
            setChmodOpen(false);
            contextMenuPathRef.current = null;
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 删除
    const [isDeleting, setIsDeleting] = useState(false);
    const handleDelete = async () => {
        if (!deleteTarget || isDeleting) return;
        setIsDeleting(true);
        try {
            await Remove(sessionId, contextMenuPathRef.current ?? joinPath(currentPath, deleteTarget));
            setDeleteOpen(false);
            setDeleteTarget("");
            contextMenuPathRef.current = null;
            loadDir(currentPath);
        } catch (err) {
            handleAppError(err);
        } finally {
            setIsDeleting(false);
        }
    };

    const goParent = () => {
        const p = parentPath(currentPath);
        if (p !== currentPath) loadDir(p);
    };

    // 全局搜索：递归搜索整个文件系统，使用防抖避免频繁请求
    const triggerGlobalSearch = useCallback((query: string) => {
        // 清除上一次的防抖定时器
        if (searchTimer.current) {
            clearTimeout(searchTimer.current);
        }

        const trimmed = query.trim();
        if (!trimmed) {
            ++searchIdRef.current; // 使在途搜索失效，防止旧结果覆盖已清空状态
            setSearchResults(null);
            setSearching(false);
            return;
        }

        setSearching(true);
        searchTimer.current = setTimeout(async () => {
            const myId = ++searchIdRef.current;
            try {
                // 全局搜索从根目录 / 开始
                const results = await SearchFiles(sessionId, "/", trimmed, 200);
                // 检查是否是最新的搜索请求
                if (myId !== searchIdRef.current) return;
                setSearchResults(results || []);
            } catch (err) {
                if (myId !== searchIdRef.current) return;
                handleAppError(err);
                setSearchResults([]);
            } finally {
                if (myId === searchIdRef.current) {
                    setSearching(false);
                }
            }
        }, 500);
    }, [sessionId]);

    // 组件卸载时清理防抖定时器
    useEffect(() => {
        return () => {
            if (searchTimer.current) {
                clearTimeout(searchTimer.current);
            }
        };
    }, []);

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
            if (treeResizeCleanupRef.current) {
                treeResizeCleanupRef.current();
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
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDualPanel((d) => !d)}
                    title={t("toggle_dual_panel")}
                    className={cn(dualPanel && "bg-accent text-accent-foreground")}
                >
                    <Columns className="size-4" />
                </Button>
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

            {/* 搜索栏：支持当前目录过滤 / 全系统递归搜索两种模式 */}
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
                {/* 搜索模式切换按钮 */}
                <button
                    onClick={() => {
                        const newMode = searchMode === "local" ? "global" : "local";
                        setSearchMode(newMode);
                        // 切换模式时清空搜索结果，使在途搜索失效
                        ++searchIdRef.current;
                        setSearchResults(null);
                        // 如果有搜索文本且切换到 global，触发全局搜索
                        if (newMode === "global" && searchText.trim()) {
                            triggerGlobalSearch(searchText);
                        }
                    }}
                    className={cn(
                        "shrink-0 rounded p-0.5 transition-colors",
                        searchMode === "global"
                            ? "text-primary bg-primary/10"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                    title={searchMode === "local" ? t("search_mode_local") : t("search_mode_global")}
                >
                    {searchMode === "local"
                        ? <Search className="size-3.5" />
                        : <FolderSearch className="size-3.5" />
                    }
                </button>
                <input
                    value={searchText}
                    onChange={(e) => {
                        const val = e.target.value;
                        setSearchText(val);
                        if (searchMode === "global") {
                            // 全局搜索：防抖 500ms
                            triggerGlobalSearch(val);
                        }
                    }}
                    placeholder={searchMode === "local"
                        ? t("search_placeholder")
                        : t("search_global_placeholder")
                    }
                    className="h-5 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            setSearchText("");
                            setSearchResults(null);
                        }
                    }}
                />
                {searching && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
                {searchText && !searching && (
                    <button
                        onClick={() => {
                            setSearchText("");
                            setSearchResults(null);
                        }}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title={t("clear", { ns: "common", defaultValue: "Clear" })}
                    >
                        <X className="size-3.5" />
                    </button>
                )}
            </div>

            {/* 文件列表区域：双面板模式下左侧显示目录树 */}
            <div className="flex flex-1 overflow-hidden">
                {dualPanel && (
                    <>
                        {/* 左侧目录树导航 */}
                        <div
                            className="flex flex-col overflow-hidden border-r border-border bg-muted/10"
                            style={{ width: treeWidth, flexShrink: 0 }}
                        >
                            <div className="border-b border-border px-2 py-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                                {t("directory_tree")}
                            </div>
                            <div className="flex-1 overflow-auto py-1 select-none">
                                {visibleTreeNodes.map((node) => (
                                    <div
                                        key={node.path}
                                        className={cn(
                                            "flex items-center gap-1 cursor-pointer rounded-sm py-0.5 pr-1 text-xs hover:bg-accent",
                                            currentPath === node.path
                                                ? "bg-accent text-accent-foreground font-medium"
                                                : "text-muted-foreground"
                                        )}
                                        style={{ paddingLeft: node.depth * 12 + 4 }}
                                        onClick={() => loadDir(node.path)}
                                        title={node.path}
                                    >
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleTreeNode(node.path);
                                            }}
                                            className="flex shrink-0 items-center hover:text-foreground"
                                        >
                                            {node.expanded
                                                ? <ChevronDown className="size-3" />
                                                : <ChevronRight className="size-3" />}
                                        </button>
                                        {node.expanded
                                            ? <FolderOpen className="size-3.5 shrink-0 text-primary/70" />
                                            : <Folder className="size-3.5 shrink-0 text-primary/70" />}
                                        <span className="truncate">{node.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        {/* 可拖拽分隔条 */}
                        <div
                            onMouseDown={startTreeResize}
                            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
                        />
                    </>
                )}
                {/* 右侧文件列表 / 搜索结果 */}
                <div className="flex-1 overflow-hidden">
                    {searchResults ? (
                        /* 全局搜索结果列表 */
                        <div className="flex h-full flex-col overflow-hidden">
                            <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                                {searching
                                    ? t("searching")
                                    : t("search_results_count", { count: searchResults.length })
                                }
                            </div>
                            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                                {searchResults.length === 0 && !searching ? (
                                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                        {t("no_search_results")}
                                    </div>
                                ) : (
                                    searchResults.map((item) => (
                                        <div
                                            key={item.path}
                                            onClick={() => {}}
                                            onDoubleClick={() => {
                                                if (item.isDir) {
                                                    loadDir(item.path);
                                                } else {
                                                    // 导航到文件所在目录
                                                    const dir = item.path.substring(0, item.path.lastIndexOf("/")) || "/";
                                                    loadDir(dir);
                                                }
                                                setSearchResults(null);
                                                setSearchText("");
                                            }}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                // 将搜索结果转为 FileEntry 供右键菜单使用
                                                // fullPath 存储绝对路径，避免操作错误文件
                                                setContextMenu({
                                                    entry: {
                                                        name: item.name,
                                                        size: item.size,
                                                        mode: "",
                                                        modTime: "",
                                                        isDir: item.isDir,
                                                        isSymlink: false,
                                                    },
                                                    x: e.clientX,
                                                    y: e.clientY,
                                                    fullPath: item.path,
                                                });
                                            }}
                                            className="grid cursor-default items-center gap-2 px-3 py-1.5 text-sm overflow-hidden transition-colors hover:bg-accent/60"
                                            style={{ gridTemplateColumns: "minmax(0,1fr) 60px" }}
                                            title={item.path}
                                        >
                                            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                                                <span className="shrink-0">
                                                    {item.isDir
                                                        ? <Folder className="size-4 text-primary" />
                                                        : <FileText className="size-4 text-muted-foreground" />
                                                    }
                                                </span>
                                                <div className="flex min-w-0 flex-col">
                                                    <span className={cn("truncate", item.isDir && "font-medium")}>
                                                        {item.name}
                                                    </span>
                                                    <span className="truncate text-[0.625rem] text-muted-foreground/60">
                                                        {item.path}
                                                    </span>
                                                </div>
                                            </div>
                                            <span className="truncate text-right text-muted-foreground">
                                                {item.isDir ? "-" : formatFileSize(item.size)}
                                            </span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    ) : (
                        <FileTable
                            entries={entries}
                            loading={loading}
                            onOpen={handleOpen}
                            onContextMenu={(entry, e) => { contextMenuPathRef.current = null; setContextMenu({ entry, x: e.clientX, y: e.clientY }); }}
                            filterText={searchText}
                            onScrollChange={(top) => { currentScrollTop.current = top; }}
                            restoreScrollTop={restoreScrollTop}
                        />
                    )}
                </div>
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
                        <DropdownMenuItem onClick={() => { setRenameTarget(contextMenu.entry.name); setRenameValue(contextMenu.entry.name); setRenameOpen(true); contextMenuPathRef.current = contextMenu.fullPath ?? null; setContextMenu(null); }}>
                            <Pencil className="mr-2 size-4" /> {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setChmodTarget(contextMenu.entry.name); setChmodValue(toOctal(contextMenu.entry.mode)); setChmodOpen(true); contextMenuPathRef.current = contextMenu.fullPath ?? null; setContextMenu(null); }}>
                            <Lock className="mr-2 size-4" /> {t("chmod")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => { setDeleteTarget(contextMenu.entry.name); setDeleteOpen(true); contextMenuPathRef.current = contextMenu.fullPath ?? null; setContextMenu(null); }}
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
                onClose={() => !isDeleting && setDeleteOpen(false)}
                onConfirm={handleDelete}
                title={t("delete")}
                description={t("delete_confirm", { name: deleteTarget })}
                confirmDisabled={isDeleting}
            />
        </div>
    );
}
