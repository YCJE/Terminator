// SFTP 文件管理面板：FinalShell 风格的侧边面板，放在终端右侧
// 提供目录浏览、文件操作（增删改查）、上传/下载、拖拽上传、传输队列等能力

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowUp,
    RefreshCw,
    Upload,
    FolderPlus,
    ChevronRight,
    Columns,
    Folder,
    Download,
    Pencil,
    FileText,
    Trash2,
    Search,
    X,
    FolderSearch,
    Loader2,
    Crosshair,
    SquareTerminal,
    Eye,
    EyeOff,
    Info,
    Copy,
    FileArchive,
    Server,
    ExternalLink,
} from "lucide-react";
import { Dialogs, Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import type { FileEntry, SearchResultEntry } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { Service as EditorService } from "../../../bindings/terminator-desktop/backend/internal/services/editor";
import { useTransferStore, type TransferItem } from "@/store/transferStore";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { AppEvent } from "@/lib/events";
import { REMOTE_PATH_MIME, REMOTE_PATHS_MIME, LOCAL_PATHS_MIME, shellQuote, joinLocalPath } from "@/lib/remotePath";
import { isTransferCanceled } from "@/lib/sftpEvents";
import { scheduleTransfer } from "@/lib/transferScheduler";
import { sendSessionInput } from "@/lib/sessionTransport";
import { isSshKind } from "@/lib/sessionBackend";
import { FileTable } from "@/components/sftp/FileTable";
import { LocalFilePane } from "@/components/sftp/LocalFilePane";
import { DistributeDialog, type DistributePolicy, type DistributeTarget } from "@/components/sftp/DistributeDialog";
import { CrossCopyDialog } from "@/components/sftp/CrossCopyDialog";
import { SftpBookmarksMenu } from "@/components/sftp/SftpBookmarksMenu";
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
import { formatFileSize, formatDateTime } from "@/lib/format";
import { handleAppError } from "@/lib/error";
import { useTranslation } from "react-i18next";

// 待上传文件与远端已有同名条目冲突，等用户确认覆盖还是跳过
interface UploadConflict {
    localPath: string;
    remotePath: string;
    name: string;
    dir: string;
    /** true 表示这是目录压缩上传的顶层目录冲突，确认后走 UploadDirArchive */
    archive?: boolean;
}

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
// 同时兼容 POSIX（/）与 Windows（\）路径分隔符：
// Windows 上 Dialogs.OpenFile 返回的本地路径使用反斜杠，
// 仅按 "/" 分割会导致整个路径被当作文件名上传到远程。
function basename(p: string): string {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
}

// 打包下载的默认压缩包文件名：单项沿用其名称，多项按时间戳命名。
function archiveFileName(names: string[]): string {
    if (names.length === 1) {
        const name = names[0];
        return /\.zip$/i.test(name) ? name.replace(/\.zip$/i, "-archive.zip") : `${name}.zip`;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `archive-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
        + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}

// 可在远端解压的压缩包格式（与后端 extractCommand 支持的范围一致）
const ARCHIVE_NAME_PATTERN = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|7z|gz)$/i;

function isArchiveName(name: string): boolean {
    return ARCHIVE_NAME_PATTERN.test(name);
}

// 将权限字符串（数字或符号形式）转换为八进制字符串，用于权限编辑预填
// 支持 setuid/setgid/sticky 特殊权限位
function toOctal(mode: string): string {
    if (!mode) return ""; // 权限未知时返回空，避免误填 755 覆盖 restrictive 权限
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
    const removeTransfer = useTransferStore((s) => s.removeTransfer);
    // 订阅当前会话状态，仅在连接成功后才加载文件
    const sessionStatus = useSessionStore((s) => {
        const sess = s.sessions.find((x) => x.id === sessionId);
        return sess?.status || "connecting";
    });
    // 终端 shell 上报的当前目录（OSC 7），仅在跟随开关开启时用于自动导航
    const sessionCwd = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.cwd);
    const sftpFollowCwd = useUIStore((s) => s.sftpFollowCwd);
    const setSftpFollowCwd = useUIStore((s) => s.setSftpFollowCwd);

    const [currentPath, setCurrentPath] = useState("/");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);
    // 隐藏文件开关：默认显示（SSH 用户通常需要 .ssh/.bashrc 等点文件）
    const [showHidden, setShowHidden] = useState(true);
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

    // 右键菜单状态（fullPath 用于搜索结果中的绝对路径操作）
    const [contextMenu, setContextMenu] = useState<{ entry: FileEntry; x: number; y: number; fullPath?: string } | null>(null);

    // 解析文件路径：优先使用调用方显式给出的绝对路径（搜索结果），
    // 否则按当前目录拼接。不能隐式读取 contextMenu 状态——右键菜单可能与本次
    // 双击操作并非同一文件（菜单关闭与双击事件存在时序差），会把预览/保存指向错误文件。
    const resolveEntryPath = (entry: FileEntry, fullPath?: string) => {
        return fullPath ?? joinPath(currentPath, entry.name);
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
    // 属性对话框展示的条目（大小/时间/权限），与 chmod 复用同一个弹窗
    const [chmodEntry, setChmodEntry] = useState<FileEntry | null>(null);
    const [chmodEntryPath, setChmodEntryPath] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState("");
    // 多选：Ctrl/Shift 点击选中的条目名，用于批量删除
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [isBatchDownloading, setIsBatchDownloading] = useState(false);
    const [isArchiving, setIsArchiving] = useState(false);
    // 上传冲突：远端已存在同名条目的待上传项，等用户决定覆盖还是跳过
    const [uploadConflicts, setUploadConflicts] = useState<UploadConflict[]>([]);
    // 下载覆盖确认：本地目标已存在时先让用户确认，避免目录/批量下载静默覆盖本地文件
    const [downloadConflicts, setDownloadConflicts] = useState<string[]>([]);
    const downloadResolveRef = useRef<((ok: boolean) => void) | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
    const [previewContent, setPreviewContent] = useState("");
    // 打开预览时的原始内容：用于判断编辑态是否有未保存修改
    const [previewOriginalContent, setPreviewOriginalContent] = useState("");
    const [previewEditing, setPreviewEditing] = useState(false);
    const [previewPath, setPreviewPath] = useState("");
    const [previewSaving, setPreviewSaving] = useState(false);
    // 未保存修改的关闭确认：放弃修改 / 继续编辑
    const [discardPreviewOpen, setDiscardPreviewOpen] = useState(false);

    // 拖拽与面板宽度
    const [isDragOver, setIsDragOver] = useState(false);
    const [width, setWidth] = useState(360);

    // 双栏模式：左侧本地文件栏 + 右侧远端文件列表
    const [localPaneWidth, setLocalPaneWidth] = useState(260);
    // 多服务器分发：本地栏选中的路径与对话框开关
    const [distributePaths, setDistributePaths] = useState<string[]>([]);
    const [distributeOpen, setDistributeOpen] = useState(false);
    // 跨服务器复制：待复制的远端路径与对话框开关
    const [copyPaths, setCopyPaths] = useState<string[]>([]);
    const [copyOpen, setCopyOpen] = useState(false);
    // 书签作用域：优先主机 ID，缺失时退化为 user@host:port，
    // 使同一台服务器的多个会话共享同一组书签
    const bookmarkScope = useSessionStore((s) => {
        const session = s.sessions.find((item) => item.id === sessionId);
        if (!session) return sessionId;
        return session.hostId
            || `${session.config.username}@${session.config.host}:${session.config.port}`;
    });
    // 本地栏当前目录：批量下载直接落到这里，无需再弹目录选择框
    const localDirRef = useRef("");
    // 面板实际渲染宽度：窄窗口下 CSS max-width 会把面板压窄，
    // 本地栏需要按实际宽度收缩，避免把远端列表挤成 0 宽。
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelWidth, setPanelWidth] = useState(width);
    useEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setPanelWidth(entry.contentRect.width);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const effectiveLocalWidth = Math.min(localPaneWidth, Math.max(140, panelWidth - 180));

    // 请求序列号，防止快速切换目录时的竞态条件
    const loadIdRef = useRef(0);
    // 静默刷新（上传/删除完成后刷新列表）的序列号，与 loadIdRef 分开：
    // 刷新不应让正在进行的目录切换失效（否则用户点了新目录，结果被刷新的
    // 旧目录列表覆盖，面板停在原目录），但会话切换时必须让它失效。
    const refreshIdRef = useRef(0);

    // 预览请求序列号：切换会话时递增，使在途的 ReadFile 失效。
    // 与 loadIdRef 分开：loadIdRef 会被目录导航递增，若复用它，
    // "预览途中切换目录"会把正在加载的预览误当作过期而取消。
    const previewIdRef = useRef(0);
    // 预览内容所属的会话：切换标签后预览仍保留时，保存必须写回原会话，
    // 否则会把旧主机的文件内容写进新主机的同名路径。
    const previewSessionIdRef = useRef("");
    // 未保存修改标记的 ref：会话切换 effect 依赖 sessionId，
    // 不能把 dirty 写进依赖数组（否则每次输入都会重新执行清理逻辑）。
    const previewDirtyRef = useRef(false);
    // 编辑态下内容与原始内容不一致即视为有未保存修改
    const previewDirty = previewEditing && previewContent !== previewOriginalContent;
    previewDirtyRef.current = previewDirty;

    // 清空搜索状态：使在途搜索失效、取消未触发的防抖定时器、复位结果与加载态。
    // 清空文本/结果时必须统一走这里：只调用 setSearchResults(null) 而不递增
    // searchIdRef，已发出的全局搜索请求在返回后仍会通过 myId 校验并回填结果。
    const resetSearchState = useCallback(() => {
        ++searchIdRef.current;
        if (searchTimer.current) {
            clearTimeout(searchTimer.current);
            searchTimer.current = null;
        }
        setSearchResults(null);
        setSearching(false);
    }, []);

    // 加载指定目录的文件列表（带竞态保护 + 滚动位置记忆）
    const loadDir = useCallback(async (path: string) => {
        // 保存当前目录的滚动位置，以便返回时恢复
        scrollPositions.current.set(currentPathRef.current, currentScrollTop.current);
        // 设置目标目录的恢复位置（首次访问为 0）
        setRestoreScrollTop(scrollPositions.current.get(path) ?? 0);
        // 清空搜索文本和结果（统一走 resetSearchState，
        // 使在途的全局搜索请求失效，避免其返回后把结果回填到已清空的列表）
        setSearchText("");
        resetSearchState();

        const myId = ++loadIdRef.current;
        setLoading(true);
        try {
            const list = await SftpService.ListDir(sessionId, path);
            if (myId !== loadIdRef.current) return;
            setCurrentPath(path);
            setEntries(list || []);
        } catch (err) {
            if (myId !== loadIdRef.current) return;
            handleAppError(err);
        } finally {
            if (myId === loadIdRef.current) setLoading(false);
        }
    }, [sessionId, resetSearchState]);

    // 命令面板搜索远端文件后的跳转请求：切到目标目录（文件则切到其父目录）
    const sftpNavigateRequest = useUIStore((s) => s.sftpNavigateRequest);
    const lastNavigateNonceRef = useRef(0);
    useEffect(() => {
        const request = sftpNavigateRequest;
        if (!request || request.sessionId !== sessionId) return;
        // nonce 单调递增：同一次请求只处理一次，避免重渲染时反复导航
        if (request.nonce <= lastNavigateNonceRef.current) return;
        // 会话尚未连接时不要消费请求：连接成功后本 effect 会因 sessionStatus
        // 变化再次执行，届时再执行导航；提前消费会让请求永久丢失。
        if (sessionStatus !== "connected") return;
        lastNavigateNonceRef.current = request.nonce;
        void loadDir(request.path);
    }, [sftpNavigateRequest, sessionId, sessionStatus, loadDir]);

    // 静默刷新当前目录：增删改/上传完成后只替换列表数据，
    // 不显示整页 loading、不清空搜索与滚动位置，避免列表闪空。
    const refreshDir = useCallback(async (path: string) => {
        if (path !== currentPathRef.current) return;
        const myId = ++refreshIdRef.current;
        try {
            const list = await SftpService.ListDir(sessionId, path);
            if (myId !== refreshIdRef.current) return;
            // 请求期间用户可能已切到其它目录：此时旧目录的列表不能回填
            if (path !== currentPathRef.current) return;
            setEntries(list || []);
        } catch {
            // 静默刷新失败时保留现有列表，真正的错误由用户的下一次操作暴露
        }
    }, [sessionId]);

    // 切换会话时清空所有与会话绑定的状态。
    // 面板在切换会话时不会卸载（TerminalStack 复用同一实例），若不重置，
    // 上一个主机的搜索结果、右键菜单路径和各操作对话框会残留到新会话：
    // 此时确认删除/重命名会用新会话的 sessionId 去操作旧主机的路径，属于跨会话误操作。
    useEffect(() => {
        // 使在途的全局搜索失效，并取消尚未触发的防抖定时器
        resetSearchState();
        setSearchText("");
        setSearchMode("local");
        // 使在途的目录/目录树加载失效：新会话可能尚未连接，若不递增序列号，
        // 上一个会话的在途请求返回后仍会通过校验，把旧主机的文件写入新会话面板
        ++loadIdRef.current;
        // 静默刷新同样必须失效：它不属于 loadIdRef 的序列，单独递增
        ++refreshIdRef.current;
        // 使在途的文件预览失效：否则旧主机的预览内容会在切换后回填，
        // 此时"编辑→保存"会用新会话身份写入旧主机的路径（跨会话误写）
        ++previewIdRef.current;

        // 关闭右键菜单与全部文件操作对话框
        setContextMenu(null);
        contextMenuPathRef.current = null;
        setMkdirOpen(false);
        setMkdirValue("");
        setRenameOpen(false);
        setRenameValue("");
        setRenameTarget("");
        setChmodOpen(false);
        setChmodValue("");
        setChmodTarget("");
        setChmodEntry(null);
        setChmodEntryPath("");
        setDeleteOpen(false);
        setDeleteTarget("");
        // 批量删除/上传冲突的选中与待办同样绑定在旧会话上，必须一并清空
        setSelectedNames(new Set());
        setBatchDeleteOpen(false);
        setUploadConflicts([]);
        // 会话切换时中止仍在等待"覆盖确认"的下载，避免旧会话的下载落到新面板
        downloadResolveRef.current?.(false);
        downloadResolveRef.current = null;
        setDownloadConflicts([]);
        // 有未保存修改时保留预览：内容属于原会话，保存按 previewSessionId 写回
        // 原主机。直接清空会让"切换标签"这个常见操作静默丢弃编辑内容。
        if (!previewDirtyRef.current) {
            setPreviewOpen(false);
            setPreviewEntry(null);
            setPreviewContent("");
            setPreviewOriginalContent("");
            setPreviewPath("");
            setPreviewEditing(false);
            setDiscardPreviewOpen(false);
            previewSessionIdRef.current = "";
        }

        // 滚动位置属于单个主机的目录结构，跨会话复用会跳到错误位置
        scrollPositions.current.clear();
        currentScrollTop.current = 0;
        setRestoreScrollTop(0);

        // 立即清空列表：新会话可能尚未连接，此时不能显示上一个主机的文件
        setEntries([]);
        setCurrentPath("/");
        setLoading(true);
    }, [sessionId, resetSearchState]);

    // 初始化：sessionId 变化或会话状态变为 connected 时加载文件
    useEffect(() => {
        // 会话未连接时不加载，避免 SSH 连接建立前调用 SFTP 导致 "session not found"
        if (sessionStatus !== "connected") {
            // 已断开（或连接失败）时必须结束加载态：切换会话时本面板会把 loading
            // 置为 true，若就此返回，面板会永远停在转圈状态。
            // 仍在连接中则保留加载态，连接成功后本 effect 会再次触发。
            if (sessionStatus === "disconnected") setLoading(false);
            return;
        }
        let cancelled = false;
        // 递增 loadIdRef 使旧会话的在途 loadDir 请求失效
        const initId = ++loadIdRef.current;
        SftpService.HomeDir(sessionId)
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

    // 跟随终端目录：shell 通过 OSC 7 上报 cwd 后自动切换到对应目录。
    // 只在 cwd 变化时触发（依赖 sessionCwd），用户手动浏览不会被打断。
    useEffect(() => {
        if (!sftpFollowCwd || sessionStatus !== "connected" || !sessionCwd) return;
        if (sessionCwd === currentPathRef.current) return;
        loadDir(sessionCwd);
    }, [sessionCwd, sftpFollowCwd, sessionStatus, loadDir]);

    // 隐藏文件开关只影响显示层：批量操作仍以原始 entries 为准，
    // 避免用户切换开关时选中项被悄悄清空或误删。
    const visibleEntries = useMemo(
        () => (showHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."))),
        [entries, showHidden]
    );
    // 全局搜索结果也遵守隐藏文件开关
    const visibleSearchResults = useMemo(
        () => (searchResults === null
            ? null
            : showHidden
                ? searchResults
                : searchResults.filter((item) => !item.name.startsWith("."))),
        [searchResults, showHidden]
    );

    // 拖拽调整本地栏宽度
    const localResizeCleanupRef = useRef<(() => void) | null>(null);

    const startLocalResize = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = localPaneWidth;
        const onMove = (ev: MouseEvent) => {
            const delta = ev.clientX - startX;
            const newWidth = Math.min(Math.max(startWidth + delta, 180), 520);
            setLocalPaneWidth(newWidth);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            localResizeCleanupRef.current = null;
        };
        document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        localResizeCleanupRef.current = () => {
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
    const handlePreview = async (entry: FileEntry, fullPath?: string) => {
        // 显式检查 size 是否为有效数字，undefined/null 时拒绝预览
        if (typeof entry.size !== "number" || entry.size > PREVIEW_LIMIT) {
            toast.error(t("file_too_large"));
            return;
        }
        const myId = ++previewIdRef.current;
        try {
            const path = resolveEntryPath(entry, fullPath);
            const content = await SftpService.ReadFile(sessionId, path);
            // 切换会话后旧请求的返回必须丢弃：否则会把上一个主机的文件内容
            // 回填到新会话面板，且此时"保存"会用新 sessionId 写入旧主机的路径
            if (myId !== previewIdRef.current) return;
            setPreviewEntry(entry);
            setPreviewContent(content ?? "");
            setPreviewOriginalContent(content ?? "");
            // 记录内容所属会话：之后即使切到别的标签，保存也会写回原主机
            previewSessionIdRef.current = sessionId;
            setPreviewPath(path);
            setPreviewEditing(false); // 默认只读模式
            setPreviewOpen(true);
        } catch (err) {
            if (myId !== previewIdRef.current) return;
            handleAppError(err);
        }
    };

    // 用系统默认程序打开远端文件：下载到临时目录后拉起编辑器，
    // 保存后由后端自动回传（远端在此期间被改动时跳过并提示冲突）。
    const handleOpenExternalEditor = async (entry: FileEntry, fullPath?: string) => {
        const remotePath = fullPath ?? joinPath(currentPath, entry.name);
        try {
            await EditorService.OpenRemoteFile(sessionId, remotePath);
            toast.success(t("editor_open_success"));
        } catch (err) {
            handleAppError(err);
        }
    };

    // 保存编辑后的文件内容到远程
    const handleSavePreview = async () => {
        if (!previewPath) return;
        // 用预览所属会话而非当前会话：用户可能在编辑期间切换了标签
        const targetSessionId = previewSessionIdRef.current || sessionId;
        setPreviewSaving(true);
        try {
            await SftpService.WriteFile(targetSessionId, previewPath, previewContent);
            // 保存成功后原始内容同步为当前内容，重新编辑不会立即被判为未保存
            setPreviewOriginalContent(previewContent);
            setPreviewEditing(false);
            toast.success(t("save_success"));
        } catch (err) {
            handleAppError(err);
        } finally {
            setPreviewSaving(false);
        }
    };

    /** 关闭预览：清空内容与所属会话，避免下次打开时残留上一次编辑 */
    const closePreview = () => {
        setDiscardPreviewOpen(false);
        setPreviewOpen(false);
        setPreviewEntry(null);
        setPreviewContent("");
        setPreviewOriginalContent("");
        setPreviewPath("");
        setPreviewEditing(false);
        previewSessionIdRef.current = "";
    };

    /** 关闭请求：存在未保存修改时先确认，避免误丢编辑内容 */
    const requestClosePreview = () => {
        if (previewDirty) {
            setDiscardPreviewOpen(true);
            return;
        }
        closePreview();
    };

    // 真正发起一次上传（冲突检查已完成）。
    // 先进入"排队中"，由调度器在会话并发未满时切到 active 并调用后端。
    // targetSessionId 默认为本面板会话；多服务器分发时会指向其他会话。
    // quiet=true 时不弹单文件成功提示，由调用方汇总结果，避免批量分发刷屏。
    const runUpload = (
        localPath: string,
        remotePath: string,
        uploadDir: string,
        targetSessionId: string = sessionId,
        quiet = false,
    ) => {
        const name = basename(localPath);
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId: targetSessionId,
            filename: name,
            type: "upload",
            transferred: 0,
            total: 0,
            status: "queued",
            localPath,
            remotePath,
        });
        scheduleTransfer(targetSessionId, transferId, async () => {
            updateTransfer(transferId, { status: "active" });
            try {
                await SftpService.Upload(targetSessionId, transferId, localPath, remotePath);
                updateTransfer(transferId, { status: "success" });
                if (!quiet) toast.success(t("upload_success"));
                // 仅当用户仍在上传目录时刷新，避免跳转；静默刷新不闪空列表
                if (targetSessionId === sessionId && currentPathRef.current === uploadDir) {
                    void refreshDir(uploadDir);
                }
            } catch (err) {
                // 用户主动取消属于预期操作：不弹错误提示，队列显示"已取消"
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, { status: "error", cancelled: true });
                    return;
                }
                updateTransfer(transferId, { status: "error", error: String((err as Error)?.message ?? err) });
                handleAppError(err);
            }
        });
    };

    // 开始上传单个本地文件到当前目录。
    // 先检查远端是否已有同名条目：后端上传会直接覆盖，静默覆盖用户文件风险太大。
    // 检查本身失败时按"已存在"处理，把决定权交回用户，而不是替用户做选择。
    const startUpload = async (localPath: string) => {
        if (!localPath) return;
        const uploadDir = currentPathRef.current;
        const name = basename(localPath);
        const remotePath = joinPath(uploadDir, name);
        let exists = true;
        try {
            exists = await SftpService.Exists(sessionId, remotePath);
        } catch {
            exists = true;
        }
        if (exists) {
            setUploadConflicts((prev) => [...prev, { localPath, remotePath, name, dir: uploadDir }]);
            return;
        }
        runUpload(localPath, remotePath, uploadDir);
    };

    // 处理冲突批次：确认覆盖则逐个上传（后端写入会覆盖远端同名文件）；
    // 选择跳过则直接丢弃这批待传项（无冲突的文件已在上一步立即开始传输）。
    const resolveUploadConflicts = (overwrite: boolean) => {
        const pending = uploadConflicts;
        setUploadConflicts([]);
        if (!overwrite) {
            if (pending.length > 0) {
                toast.info(t("upload_skipped", { count: pending.length }));
            }
            return;
        }
        pending.forEach((item) => {
            if (item.archive) {
                queueArchiveUpload(item.localPath, item.dir);
                return;
            }
            runUpload(item.localPath, item.remotePath, item.dir);
        });
    };

    // 冲突文件名摘要：只列前 5 个，避免确认弹窗被超长列表撑开
    const conflictNames = useMemo(() => {
        const head = uploadConflicts.slice(0, 5).map((item) => item.name);
        const rest = uploadConflicts.length - head.length;
        return rest > 0 ? `${head.join(", ")} … (+${rest})` : head.join(", ");
    }, [uploadConflicts]);

    // 下载前检查本地目标是否已存在，存在时弹确认框。
    // 结果通过 Promise 交回调用处，确保"确认"发生在真正发起下载之前；
    // 单文件下载走系统保存对话框（原生已提示覆盖），这里主要覆盖目录与批量下载。
    const confirmLocalOverwrite = async (localPaths: string[]): Promise<boolean> => {
        if (localPaths.length === 0) return true;
        let existing: string[] = [];
        try {
            existing = (await SftpService.LocalExistingPaths(localPaths)) || [];
        } catch {
            // 检查失败不阻塞下载：真正的写入错误会由传输队列如实上报
            return true;
        }
        if (existing.length === 0) return true;
        return new Promise<boolean>((resolve) => {
            // 已有待确认的批次时先按取消结束，避免上一个调用方永久等待
            downloadResolveRef.current?.(false);
            downloadResolveRef.current = resolve;
            setDownloadConflicts(existing);
        });
    };

    const resolveDownloadConflicts = (overwrite: boolean) => {
        setDownloadConflicts([]);
        const resolve = downloadResolveRef.current;
        downloadResolveRef.current = null;
        resolve?.(overwrite);
    };

    // 覆盖确认弹窗里的文件名摘要（只列前 5 个）
    const downloadConflictNames = useMemo(() => {
        const head = downloadConflicts.slice(0, 5).map((p) => basename(p));
        const rest = downloadConflicts.length - head.length;
        return rest > 0 ? `${head.join(", ")} … (+${rest})` : head.join(", ");
    }, [downloadConflicts]);

    // 点击上传按钮：弹出系统文件选择框
    const handleUploadClick = async () => {
        try {
            const result = await Dialogs.OpenFile({
                Title: t("upload"),
                AllowsMultipleSelection: true,
                // 允许选择文件夹：选中目录时递归上传全部内容
                CanChooseDirectories: true,
                CanChooseFiles: true,
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

    // 压缩上传的入队实现（冲突检查已完成）。
    // 把本地目录打成 ZIP 单次上传，再在远端解压：
    // 大量小文件逐个上传时握手与建目录的往返开销远大于传输本身。
    const queueArchiveUpload = (localPath: string, uploadDir: string) => {
        const name = basename(localPath);
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId,
            filename: `${name}.zip`,
            type: "upload",
            transferred: 0,
            total: 0,
            status: "queued",
            localPath,
            remotePath: uploadDir,
            archiveUpload: true,
        });
        scheduleTransfer(sessionId, transferId, async () => {
            updateTransfer(transferId, {status: "active"});
            try {
                await SftpService.UploadDirArchive(sessionId, transferId, localPath, uploadDir);
                updateTransfer(transferId, {status: "success"});
                toast.success(t("upload_archive_success", {name}));
                if (currentPathRef.current === uploadDir) void refreshDir(uploadDir);
            } catch (err) {
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, {status: "error", cancelled: true});
                    return;
                }
                updateTransfer(transferId, {status: "error", error: String((err as Error)?.message ?? err)});
                handleAppError(err);
            }
        });
    };

    // 开始压缩上传：先探测远端是否已有同名顶层目录。
    // 压缩包会在远端展开成 <目录名>/…，同名目录已存在时其中的同名文件会被
    // 静默覆盖，因此与单文件上传保持一致，先让用户确认再解压。
    const startArchiveUpload = async (localPath: string) => {
        if (!localPath) return;
        const uploadDir = currentPathRef.current;
        const name = basename(localPath);
        let exists = true;
        try {
            exists = await SftpService.Exists(sessionId, joinPath(uploadDir, name));
        } catch {
            // 检查失败按"已存在"处理：把是否覆盖的决定权交给用户
            exists = true;
        }
        if (exists) {
            setUploadConflicts((prev) => [...prev, {
                localPath,
                remotePath: joinPath(uploadDir, name),
                name: `${name}/`,
                dir: uploadDir,
                archive: true,
            }]);
            return;
        }
        queueArchiveUpload(localPath, uploadDir);
    };

    // 选择要压缩上传的本地目录
    const handleArchiveUploadClick = async () => {
        try {
            const picked = await Dialogs.OpenFile({
                Title: t("upload_archive"),
                CanChooseFiles: false,
                CanChooseDirectories: true,
            });
            const dir = Array.isArray(picked) ? picked[0] : picked;
            if (!dir) return;
            // 去掉尾部斜杠：ZIP 顶层目录名不能以分隔符结尾
            void startArchiveUpload(dir.replace(/[\\/]+$/, ""));
        } catch (err) {
            const msg = String((err as Error)?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) handleAppError(err);
        }
    };

    // 在远端解压压缩包到当前目录
    const handleExtractArchive = async (archivePath: string, name: string) => {
        try {
            await SftpService.ExtractArchive(sessionId, archivePath, currentPath);
            toast.success(t("extract_success", {name}));
            void refreshDir(currentPath);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 跨服务器复制入队：后端在两个 SFTP 客户端之间直接搬运，不经过本地磁盘；
    // 目标端沿用续传临时文件，全部写完才落到最终路径。
    const startCrossCopy = (
        sourcePath: string,
        targetSessionId: string,
        targetDir: string,
        quiet = false,
    ) => {
        const name = basename(sourcePath);
        const dstPath = joinPath(targetDir, name);
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId,
            filename: name,
            type: "copy",
            transferred: 0,
            total: 0,
            status: "queued",
            remotePath: dstPath,
            sourcePath,
            targetSessionId,
        });
        scheduleTransfer(sessionId, transferId, async () => {
            updateTransfer(transferId, { status: "active" });
            try {
                await SftpService.CopyBetweenSessions(
                    sessionId, sourcePath, targetSessionId, dstPath, transferId,
                );
                updateTransfer(transferId, { status: "success" });
                if (!quiet) toast.success(t("copy_success", { name }));
            } catch (err) {
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, { status: "error", cancelled: true });
                    return;
                }
                updateTransfer(transferId, { status: "error", error: String((err as Error)?.message ?? err) });
                handleAppError(err);
            }
        });
    };

    // 执行跨服务器复制：每个条目一个传输任务，由调度器按会话并发限制执行
    const handleCrossCopy = (paths: string[], target: { sessionId: string; dir: string }) => {
        const dir = target.dir.trim();
        if (paths.length === 0 || !target.sessionId || !dir) return;
        const quiet = paths.length > 1;
        paths.forEach((p) => startCrossCopy(p, target.sessionId, dir, quiet));
        // 批量复制入队后清空选中；单条复制保留选中，便于继续操作
        if (paths.length > 1) setSelectedNames(new Set());
    };

    // 统一下载入队：新建队列条目并交给调度器，获得并发槽位后再调用后端
    const queueDownload = (
        remotePath: string,
        localPath: string,
        filename: string,
        total: number,
        notifySuccess = false,
    ) => {
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId,
            filename,
            type: "download",
            transferred: 0,
            total,
            status: "queued",
            localPath,
            remotePath,
        });
        scheduleTransfer(sessionId, transferId, async () => {
            updateTransfer(transferId, { status: "active" });
            try {
                await SftpService.Download(sessionId, transferId, remotePath, localPath);
                updateTransfer(transferId, { status: "success" });
                if (notifySuccess) toast.success(t("download_success"));
            } catch (err) {
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, { status: "error", cancelled: true });
                    return;
                }
                updateTransfer(transferId, { status: "error", error: String((err as Error)?.message ?? err) });
                handleAppError(err);
            }
        });
    };

    // 打包下载入队：后端把多个远端条目流式写成一个 ZIP，进度按已读字节汇总。
    // 不写 remotePath（打包没有单一源文件），重试时改用 archivePaths。
    const queueArchive = (remotePaths: string[], localPath: string) => {
        const transferId = crypto.randomUUID();
        addTransfer({
            id: transferId,
            sessionId,
            filename: basename(localPath),
            type: "download",
            transferred: 0,
            total: 0,
            status: "queued",
            localPath,
            archivePaths: remotePaths,
        });
        scheduleTransfer(sessionId, transferId, async () => {
            updateTransfer(transferId, { status: "active" });
            try {
                await SftpService.DownloadArchive(sessionId, transferId, remotePaths, localPath);
                updateTransfer(transferId, { status: "success" });
                toast.success(t("archive_success"));
            } catch (err) {
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, { status: "error", cancelled: true });
                    return;
                }
                updateTransfer(transferId, { status: "error", error: String((err as Error)?.message ?? err) });
                handleAppError(err);
            }
        });
    };

    // 打包下载入口：双栏模式直接落到本地栏目录，否则弹保存对话框。
    // 返回是否真正入队（用户取消对话框/覆盖确认时为 false）。
    const startArchiveDownload = async (remotePaths: string[], names: string[]): Promise<boolean> => {
        if (isArchiving || remotePaths.length === 0) return false;
        setIsArchiving(true);
        try {
            let localPath = "";
            const localDir = dualPanel ? localDirRef.current : "";
            if (localDir) {
                localPath = joinLocalPath(localDir, archiveFileName(names));
                if (!(await confirmLocalOverwrite([localPath]))) return false;
            } else {
                localPath = await Dialogs.SaveFile({
                    Title: t("archive_download"),
                    Filename: archiveFileName(names),
                });
                if (!localPath) return false;
            }
            queueArchive(remotePaths, localPath);
            return true;
        } catch (err) {
            const msg = String((err as Error)?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) {
                handleAppError(err);
            }
            return false;
        } finally {
            setIsArchiving(false);
        }
    };

    // 下载文件 / 目录：文件用保存对话框，目录用"选择目录"对话框
    const handleDownload = async (entry: FileEntry, fullPath?: string) => {
        const remotePath = resolveEntryPath(entry, fullPath);
        try {
            let localPath: string;
            if (entry.isDir) {
                // 目录下载：用户选择父目录，目标目录为 <父目录>/<远端目录名>
                // Wails 的 OpenFile 在允许选择目录时返回 string，但仍兼容数组返回
                const picked = await Dialogs.OpenFile({
                    Title: t("download"),
                    CanChooseFiles: false,
                    CanChooseDirectories: true,
                    CanCreateDirectories: true,
                });
                const parent = Array.isArray(picked) ? picked[0] : picked;
                if (!parent) return;
                localPath = joinLocalPath(parent, entry.name);
                // 目录下载会合并进已存在的同名目录并覆盖其中的同名文件，先确认
                if (!(await confirmLocalOverwrite([localPath]))) return;
            } else {
                localPath = await Dialogs.SaveFile({ Title: t("download"), Filename: entry.name });
                if (!localPath) return;
            }
            queueDownload(remotePath, localPath, entry.name, entry.size, true);
        } catch (err) {
            handleAppError(err);
        }
    };

    // 批量下载选中项到同一个本地目录，目录会递归下载到 <目录>/<远端名字>。
    // 与批量删除一样只处理仍存在于当前列表中的条目，避免残留选中名发出无效请求。
    const handleBatchDownload = async () => {
        if (isBatchDownloading || selectedNames.size === 0) return;
        const targets = entries.filter((entry) => selectedNames.has(entry.name));
        if (targets.length === 0) {
            setSelectedNames(new Set());
            return;
        }
        setIsBatchDownloading(true);
        try {
            // 双栏模式下直接下载到本地栏当前目录，省去每次选择目录
            let localDir = dualPanel ? localDirRef.current : "";
            if (!localDir) {
                const picked = await Dialogs.OpenFile({
                    Title: t("download_selected_tip", { count: targets.length }),
                    CanChooseFiles: false,
                    CanChooseDirectories: true,
                    CanCreateDirectories: true,
                });
                localDir = Array.isArray(picked) ? picked[0] : picked;
            }
            if (!localDir) return;
            // 批量下载可能覆盖本地已有文件，先一次性确认
            const localPaths = targets.map((entry) => joinLocalPath(localDir, entry.name));
            if (!(await confirmLocalOverwrite(localPaths))) return;
            targets.forEach((entry) => {
                const remotePath = resolveEntryPath(entry);
                const localPath = joinLocalPath(localDir, entry.name);
                queueDownload(remotePath, localPath, entry.name, entry.size);
            });
            setSelectedNames(new Set());
        } catch (err) {
            // 用户取消目录选择不是错误
            const msg = String((err as Error)?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) {
                handleAppError(err);
            }
        } finally {
            setIsBatchDownloading(false);
        }
    };

    // 批量打包下载选中项：一次请求生成单个 ZIP，避免大量小文件各占一个队列条目。
    const handleBatchArchive = async () => {
        if (isArchiving || selectedNames.size === 0) return;
        const targets = entries.filter((entry) => selectedNames.has(entry.name));
        if (targets.length === 0) {
            setSelectedNames(new Set());
            return;
        }
        const queued = await startArchiveDownload(
            targets.map((entry) => joinPath(currentPath, entry.name)),
            targets.map((entry) => entry.name),
        );
        // 用户取消保存/覆盖确认时保留选中，便于换个目标再试
        if (queued) setSelectedNames(new Set());
    };

    // 本地栏拖入远端条目：批量下载到本地栏当前目录
    const handleDownloadRemotePaths = async (remotePaths: string[], localDir: string) => {
        if (remotePaths.length === 0 || !localDir) return;
        const targets = remotePaths
            .map((remotePath) => ({
                remotePath,
                name: basename(remotePath),
                localPath: joinLocalPath(localDir, basename(remotePath)),
            }))
            // 拖拽载荷里的名字来自远端："." / ".." 会把下载目标拼到父目录，
            // 直接丢弃（服务端异常或恶意时才会出现）
            .filter((item) => item.name && item.name !== "." && item.name !== "..");
        if (targets.length === 0) return;
        if (!(await confirmLocalOverwrite(targets.map((item) => item.localPath)))) return;
        targets.forEach((item) => {
            const known = entries.find((entry) => entry.name === item.name);
            queueDownload(item.remotePath, item.localPath, item.name, known?.size ?? 0);
        });
    };

    // 重试失败的传输：沿用原路径并换新的 transferID 重新入队。
    // 复用旧 ID 会与后端已释放的取消上下文冲突，且旧条目已是终态无法回到 active。
    const handleRetryTransfer = (item: TransferItem) => {
        const archivePaths = item.archivePaths;
        const isCopy = item.type === "copy";
        const hasPaths = isCopy
            ? !!(item.sourcePath && item.targetSessionId && item.remotePath)
            : !!(item.localPath && (item.remotePath || (archivePaths?.length ?? 0) > 0));
        if (!hasPaths) return;
        const transferId = crypto.randomUUID();
        removeTransfer(item.id);
        addTransfer({
            id: transferId,
            sessionId: item.sessionId,
            filename: item.filename,
            type: item.type,
            transferred: 0,
            total: item.total,
            status: "queued",
            localPath: item.localPath,
            remotePath: item.remotePath,
            archivePaths,
            archiveUpload: item.archiveUpload,
            sourcePath: item.sourcePath,
            targetSessionId: item.targetSessionId,
        });
        scheduleTransfer(item.sessionId, transferId, async () => {
            updateTransfer(transferId, { status: "active" });
            try {
                if (isCopy) {
                    await SftpService.CopyBetweenSessions(
                        item.sessionId, item.sourcePath!, item.targetSessionId!,
                        item.remotePath!, transferId,
                    );
                } else if (archivePaths && archivePaths.length > 0) {
                    await SftpService.DownloadArchive(item.sessionId, transferId, archivePaths, item.localPath!);
                } else if (item.type === "upload" && item.archiveUpload) {
                    // 压缩上传必须原样重试：普通 Upload 会把目录内容平铺到目标目录
                    await SftpService.UploadDirArchive(
                        item.sessionId, transferId, item.localPath!, item.remotePath!,
                    );
                } else if (item.type === "upload") {
                    await SftpService.Upload(item.sessionId, transferId, item.localPath!, item.remotePath!);
                } else {
                    await SftpService.Download(item.sessionId, transferId, item.remotePath!, item.localPath!);
                }
                updateTransfer(transferId, { status: "success" });
            } catch (err) {
                if (isTransferCanceled(err)) {
                    updateTransfer(transferId, { status: "error", cancelled: true });
                    return;
                }
                updateTransfer(transferId, { status: "error", error: String((err as Error)?.message ?? err) });
            }
        });
    };

    // 新建文件夹
    const handleMkdir = async () => {
        const name = mkdirValue.trim();
        if (!name) return;
        try {
            await SftpService.Mkdir(sessionId, joinPath(currentPath, name));
            setMkdirOpen(false);
            setMkdirValue("");
            void refreshDir(currentPath);
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
            await SftpService.Rename(sessionId, oldPath, newPath);
            setRenameOpen(false);
            contextMenuPathRef.current = null;
            void refreshDir(currentPath);
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
            await SftpService.Chmod(
                sessionId,
                chmodEntryPath || contextMenuPathRef.current || joinPath(currentPath, chmodTarget),
                mode,
            );
            setChmodOpen(false);
            setChmodEntry(null);
            setChmodEntryPath("");
            contextMenuPathRef.current = null;
            void refreshDir(currentPath);
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
            await SftpService.Remove(sessionId, contextMenuPathRef.current ?? joinPath(currentPath, deleteTarget));
            setDeleteOpen(false);
            setDeleteTarget("");
            contextMenuPathRef.current = null;
            void refreshDir(currentPath);
        } catch (err) {
            handleAppError(err);
        } finally {
            setIsDeleting(false);
        }
    };

    // 批量删除选中项：逐个删除而不是并发，避免几百个文件同时打满 SFTP 会话；
    // 单个失败不中断后续，最后汇总失败数量。
    const handleBatchDelete = async () => {
        if (isBatchDeleting || selectedNames.size === 0) return;
        setIsBatchDeleting(true);
        // 只删除仍存在于当前目录列表中的条目：搜索态或列表刷新后，
        // 残留的选中名可能指向已经不存在的文件，避免发出无意义请求
        const names = entries
            .filter((entry) => selectedNames.has(entry.name))
            .map((entry) => entry.name);
        if (names.length === 0) {
            setIsBatchDeleting(false);
            setBatchDeleteOpen(false);
            setSelectedNames(new Set());
            return;
        }
        let failed = 0;
        let lastError: unknown = null;
        for (const name of names) {
            try {
                await SftpService.Remove(sessionId, joinPath(currentPath, name));
            } catch (err) {
                failed++;
                lastError = err;
            }
        }
        setIsBatchDeleting(false);
        setBatchDeleteOpen(false);
        setSelectedNames(new Set());
        void refreshDir(currentPath);
        if (failed > 0) {
            toast.error(t("batch_delete_partial", { count: failed }));
            if (lastError) handleAppError(lastError);
        } else {
            toast.success(t("batch_delete_success", { count: names.length }));
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
                const results = await SftpService.SearchFiles(sessionId, "/", trimmed, 200);
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

    // 后端转发的本地文件拖放：落在本面板时按当前目录上传
    const startUploadRef = useRef(startUpload);
    startUploadRef.current = startUpload;
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.FileDrop, (event) => {
            const payload = event?.data as { files?: string[]; sessionId?: string; kind?: string } | undefined;
            if (!payload || payload.kind !== "sftp" || payload.sessionId !== sessionId) return;
            // 会话未连接时不发起上传：后端会返回 session not found，用户只会看到一串失败提示
            const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
            if (!session || session.status !== "connected") return;
            (payload.files ?? []).forEach((path) => startUploadRef.current(path));
        });
        return () => unsubscribe();
    }, [sessionId]);

    // 外部编辑器自动回传结果：刷新目录并区分成功 / 冲突 / 失败三种提示
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.EditorSaved, (event) => {
            const payload = event?.data as {
                sessionId?: string;
                remotePath?: string;
                success?: boolean;
                conflict?: boolean;
                error?: string;
            } | undefined;
            if (!payload || payload.sessionId !== sessionId || !payload.remotePath) return;
            const remotePath = payload.remotePath;
            if (payload.success) {
                toast.success(t("editor_saved", { name: basename(remotePath) }));
                if (parentPath(remotePath) === currentPathRef.current) {
                    void refreshDir(currentPathRef.current);
                }
                return;
            }
            if (payload.conflict) {
                toast.warning(t("editor_conflict"));
                return;
            }
            toast.error(t("editor_save_failed", { error: payload.error ?? "" }));
        });
        return () => unsubscribe();
    }, [sessionId, t, refreshDir]);

    // 文件行拖拽：拖动已选中的行时携带整个选择，供双栏拖拽上传/下载。
    // 同时写入单路径 MIME，保证拖到终端插入路径的既有行为不变。
    const handleEntryDragStart = (
        entry: FileEntry,
        e: React.DragEvent,
        selectedNames?: string[],
        fullPath?: string,
    ) => {
        const selected = selectedNames ?? [];
        const paths = selected.length > 1
            ? entries
                .filter((item) => selected.includes(item.name))
                .map((item) => joinPath(currentPath, item.name))
            : [fullPath ?? joinPath(currentPath, entry.name)];
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(REMOTE_PATHS_MIME, JSON.stringify(paths));
        e.dataTransfer.setData(REMOTE_PATH_MIME, paths[0]);
        e.dataTransfer.setData("text/plain", paths[0]);
    };

    // 本地栏选中项上传到当前远端目录（复用冲突检查）
    const handleUploadLocalPaths = (paths: string[]) => {
        paths.forEach((path) => void startUpload(path));
    };

    // 打开多服务器分发对话框（路径来自本地栏选中项）
    const handleOpenDistribute = (paths: string[]) => {
        if (paths.length === 0) return;
        setDistributePaths(paths);
        setDistributeOpen(true);
    };

    // 执行分发：逐会话逐文件检查同名目标，按用户选择的策略覆盖或跳过。
    // 每个（会话, 文件）组合复用一个上传任务，由调度器按会话并发限制执行，
    // 多台服务器之间互不阻塞。
    const handleDistribute = async (paths: string[], targets: DistributeTarget[], policy: DistributePolicy) => {
        if (paths.length === 0 || targets.length === 0) return;
        let queued = 0;
        let skipped = 0;
        for (const target of targets) {
            const dir = target.dir.trim();
            if (!dir) continue;
            for (const localPath of paths) {
                const name = basename(localPath);
                const remotePath = joinPath(dir, name);
                let exists = false;
                try {
                    exists = await SftpService.Exists(target.sessionId, remotePath);
                } catch {
                    // 无法确认远端是否存在时，skip 策略必须按"已存在"处理：
                    // 按"不存在"继续上传会在用户明确选择跳过的情况下覆盖目标文件。
                    // overwrite 策略不受影响，照常上传。
                    if (policy === "skip") {
                        skipped++;
                        continue;
                    }
                }
                if (exists && policy === "skip") {
                    skipped++;
                    continue;
                }
                runUpload(localPath, remotePath, dir, target.sessionId, true);
                queued++;
            }
        }
        if (queued > 0 && skipped > 0) {
            toast.info(t("distribute_done_skipped", { count: queued, sessions: targets.length, skipped }));
        } else if (queued > 0) {
            toast.success(t("distribute_done", { count: queued, sessions: targets.length }));
        } else if (skipped > 0) {
            toast.info(t("distribute_all_skipped", { skipped }));
        }
    };

    // 右键「插入路径到终端」：写入当前激活的 SSH 会话命令行（不执行）
    const handleInsertPath = (entry: FileEntry, fullPath?: string) => {
        const store = useSessionStore.getState();
        const target = store.sessions.find((s) => s.id === store.activeSessionId);
        if (!target || !isSshKind(target.kind) || target.status !== "connected") {
            toast.error(t("insert_path_unavailable"));
            return;
        }
        const path = fullPath ?? joinPath(currentPath, entry.name);
        sendSessionInput(target.id, `${shellQuote(path)} `).catch(handleAppError);
    };

    // 在终端中进入目录：把 cd 命令直接发送到当前激活的 SSH 会话
    const handleCdToTerminal = (entry: FileEntry, fullPath?: string) => {
        const store = useSessionStore.getState();
        const target = store.sessions.find((s) => s.id === store.activeSessionId);
        if (!target || !isSshKind(target.kind) || target.status !== "connected") {
            toast.error(t("cd_unavailable"));
            return;
        }
        const path = fullPath ?? joinPath(currentPath, entry.name);
        sendSessionInput(target.id, `cd ${shellQuote(path)}\n`).catch(handleAppError);
    };

    // 复制远端路径到系统剪贴板
    const handleCopyPath = async (entry: FileEntry, fullPath?: string) => {
        const path = fullPath ?? joinPath(currentPath, entry.name);
        try {
            await navigator.clipboard.writeText(path);
            toast.success(t("path_copied"));
        } catch (err) {
            handleAppError(err);
        }
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
            // 双栏模式下需要更宽的面板；上限放宽到 960，仍受 CSS max-width 约束
            const newWidth = Math.min(Math.max(startWidth + delta, 280), 960);
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
            if (localResizeCleanupRef.current) {
                localResizeCleanupRef.current();
            }
            // 仍在等待"覆盖确认"的下载按取消结束，避免调用方永远挂起
            downloadResolveRef.current?.(false);
            downloadResolveRef.current = null;
        };
    }, []);

    // 拖拽本地文件/本地栏条目到面板上传（内部拖拽不带 files，不显示遮罩）
    const handleDragOver = (e: React.DragEvent) => {
        const types = Array.from(e.dataTransfer.types).map((type) => type.toLowerCase());
        if (!types.includes("files") && !types.includes(LOCAL_PATHS_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
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
        // 本地栏拖入：按当前远端目录逐个上传
        const localPaths = e.dataTransfer.getData(LOCAL_PATHS_MIME);
        if (localPaths) {
            try {
                const parsed = JSON.parse(localPaths) as unknown;
                if (Array.isArray(parsed)) {
                    parsed
                        .filter((item): item is string => typeof item === "string" && item.length > 0)
                        .forEach((path) => void startUpload(path));
                    return;
                }
            } catch {
                // 非法载荷：回退到系统文件拖拽
            }
        }
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
            ref={panelRef}
            className={cn(
                "sftp-panel relative cursor-default",
                isDragOver && "ring-2 ring-inset ring-primary"
            )}
            style={{ width }}
            data-file-drop-target
            data-session-id={sessionId}
            data-drop-kind="sftp"
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
            <div className="flex items-center justify-between border-b border-[var(--hairline)] px-3 py-2">
                <span className="text-[12.5px] font-normal text-[var(--fg-strong)]">{t("file_panel_title")}</span>
                <div className="flex items-center gap-0.5">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setSftpFollowCwd(!sftpFollowCwd)}
                        title={sftpFollowCwd ? t("follow_cwd_on") : t("follow_cwd_off")}
                        className={cn(sftpFollowCwd && "bg-[var(--surface-3)] text-[var(--fg-strong)]")}
                    >
                        <Crosshair className="size-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setShowHidden((v) => !v)}
                        title={showHidden ? t("hide_hidden") : t("show_hidden")}
                    >
                        {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                            setDualPanel((d) => {
                                const next = !d;
                                // 打开双栏时给面板留出本地栏的空间
                                if (next) setWidth((w) => Math.max(w, 560));
                                return next;
                            });
                        }}
                        title={t("toggle_dual_panel")}
                        className={cn(dualPanel && "bg-[var(--surface-3)] text-[var(--fg-strong)]")}
                    >
                        <Columns className="size-4" />
                    </Button>
                </div>
            </div>

            {/* 双栏区域：本地文件栏 + 远端文件列 */}
            <div className="flex flex-1 overflow-hidden">
                {dualPanel && (
                    <>
                        <LocalFilePane
                            width={effectiveLocalWidth}
                            showHidden={showHidden}
                            onUploadPaths={handleUploadLocalPaths}
                            onDownloadRemotePaths={handleDownloadRemotePaths}
                            onDistributePaths={handleOpenDistribute}
                            onPathChange={(path) => { localDirRef.current = path; }}
                        />
                        <div onMouseDown={startLocalResize} className="sftp-resizer" />
                    </>
                )}

                {/* 远端文件列：工具栏 + 搜索 + 列表 */}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* 工具栏：返回上级 + 面包屑 + 操作按钮 */}
            <div className="sftp-bar">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={goParent}
                    title={t("parent_dir")}
                    disabled={currentPath === "/"}
                >
                    <ArrowUp className="size-4" />
                </Button>

                <div
                    className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden"
                    title={currentPath}
                >
                    {crumbs.map((seg, idx) => (
                        <div key={seg.path} className="flex shrink-0 items-center">
                            {idx > 0 && <ChevronRight className="size-3 text-[var(--fg-subtle)]" />}
                            <button
                                type="button"
                                onClick={() => loadDir(seg.path)}
                                className="sftp-crumb"
                            >
                                {seg.name}
                            </button>
                        </div>
                    ))}
                </div>

                <Button variant="ghost" size="icon-sm" onClick={() => loadDir(currentPath)} title={t("refresh")}>
                    <RefreshCw className="size-4" />
                </Button>
                <SftpBookmarksMenu scope={bookmarkScope} currentPath={currentPath} onNavigate={loadDir} />
                <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" title={t("upload")}>
                            <Upload className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuItem onClick={() => void handleUploadClick()}>
                            <Upload className="size-4" /> {t("upload")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void handleArchiveUploadClick()}>
                            <FileArchive className="size-4" /> {t("upload_archive")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => { setMkdirValue(""); setMkdirOpen(true); }}
                    title={t("mkdir")}
                >
                    <FolderPlus className="size-4" />
                </Button>
                {/* 有选中项时出现批量删除入口，避免在无选中状态下占用固定位置 */}
                {selectedNames.size > 0 && (
                    <>
                        <span
                            className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.625rem] tabular-nums text-primary"
                            title={t("delete_selected_tip", { count: selectedNames.size })}
                        >
                            {selectedNames.size}
                        </span>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={handleBatchDownload}
                            disabled={isBatchDownloading}
                            title={t("download_selected_tip", { count: selectedNames.size })}
                        >
                            {isBatchDownloading ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Download className="size-4" />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={handleBatchArchive}
                            disabled={isArchiving}
                            title={t("archive_selected_tip", { count: selectedNames.size })}
                        >
                            {isArchiving ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <FileArchive className="size-4" />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                const paths = entries
                                    .filter((entry) => selectedNames.has(entry.name))
                                    .map((entry) => joinPath(currentPath, entry.name));
                                if (paths.length === 0) return;
                                setCopyPaths(paths);
                                setCopyOpen(true);
                            }}
                            title={t("copy_selected_tip", { count: selectedNames.size })}
                        >
                            <Server className="size-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setBatchDeleteOpen(true)}
                            title={t("delete_selected_tip", { count: selectedNames.size })}
                            className="text-destructive hover:text-destructive"
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </>
                )}
            </div>

            {/* 搜索栏：支持当前目录过滤 / 全系统递归搜索两种模式 */}
            <div className="sftp-bar">
                {/* 搜索模式切换按钮 */}
                <button
                    onClick={() => {
                        const newMode = searchMode === "local" ? "global" : "local";
                        setSearchMode(newMode);
                        // 切换模式时清空搜索结果，使在途搜索失效
                        resetSearchState();
                        // 如果有搜索文本且切换到 global，触发全局搜索
                        if (newMode === "global" && searchText.trim()) {
                            triggerGlobalSearch(searchText);
                        }
                    }}
                    className={cn(
                        "shrink-0 rounded p-0.5 transition-colors",
                        searchMode === "global"
                            ? "text-primary bg-primary/10"
                            : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
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
                    className="h-5 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--fg-subtle)]"
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            setSearchText("");
                            resetSearchState();
                        }
                    }}
                />
                {searching && <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--fg-muted)]" />}
                {searchText && !searching && (
                    <button
                        onClick={() => {
                            setSearchText("");
                            resetSearchState();
                        }}
                        className="shrink-0 text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        title={t("clear", { ns: "common", defaultValue: "Clear" })}
                    >
                        <X className="size-3.5" />
                    </button>
                )}
            </div>

            {/* 文件列表 / 搜索结果 */}
            <div className="flex-1 overflow-hidden">
                    {visibleSearchResults ? (
                        /* 全局搜索结果列表 */
                        <div className="flex h-full flex-col overflow-hidden">
                            <div className="border-b border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--fg-subtle)]">
                                {searching
                                    ? t("searching")
                                    : t("search_results_count", { count: visibleSearchResults.length })
                                }
                            </div>
                            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                                {visibleSearchResults.length === 0 && !searching ? (
                                    <div className="sftp-empty">
                                        {t("no_search_results")}
                                    </div>
                                ) : (
                                    visibleSearchResults.map((item) => (
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
                                                setSearchText("");
                                                resetSearchState();
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
                                            className="sftp-row is-search text-sm"
                                            style={{ gridTemplateColumns: "minmax(0,1fr) 60px" }}
                                            title={item.path}
                                            draggable
                                            onDragStart={(e) => handleEntryDragStart(
                                                { name: item.name, size: item.size, mode: "", modTime: "", isDir: item.isDir, isSymlink: false },
                                                e,
                                                undefined,
                                                item.path,
                                            )}
                                        >
                                            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                                                <span className="shrink-0">
                                                    {item.isDir
                                                        ? <Folder className="size-4 text-primary" />
                                                        : <FileText className="size-4 text-[var(--fg-muted)]" />
                                                    }
                                                </span>
                                                <div className="flex min-w-0 flex-col">
                                                    {/* 目录不再额外加粗：中文文件名无法反映 500，靠主色文件夹图标区分 */}
                                                    <span className="truncate">
                                                        {item.name}
                                                    </span>
                                                    <span className="truncate text-[0.625rem] text-[var(--fg-subtle)]">
                                                        {item.path}
                                                    </span>
                                                </div>
                                            </div>
                                            <span className="truncate text-right text-[var(--fg-muted)]">
                                                {item.isDir ? "-" : formatFileSize(item.size)}
                                            </span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    ) : (
                        <FileTable
                            entries={visibleEntries}
                            loading={loading}
                            onOpen={handleOpen}
                            onContextMenu={(entry, e) => { contextMenuPathRef.current = null; setContextMenu({ entry, x: e.clientX, y: e.clientY }); }}
                            onEntryDragStart={handleEntryDragStart}
                            filterText={searchText}
                            onScrollChange={(top) => { currentScrollTop.current = top; }}
                            restoreScrollTop={restoreScrollTop}
                            selectedNames={selectedNames}
                            onSelectionChange={(names) => setSelectedNames(new Set(names))}
                            dirKey={`${sessionId}\n${currentPath}`}
                        />
                    )}
                </div>
                </div>
            </div>

            {/* 拖拽上传提示遮罩 */}
            {isDragOver && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5">
                    <div className="rounded-lg border-2 border-dashed border-primary/50 bg-[var(--surface-1)] px-6 py-4 text-sm text-primary">
                        {t("upload")}
                    </div>
                </div>
            )}

            {/* 多服务器分发：本地栏选中项一次投递到多台已连接的 SSH 服务器 */}
            <DistributeDialog
                open={distributeOpen}
                paths={distributePaths}
                sourceSessionId={sessionId}
                onClose={() => setDistributeOpen(false)}
                onConfirm={(targets, policy) => {
                    setDistributeOpen(false);
                    void handleDistribute(distributePaths, targets, policy);
                }}
            />

            {/* 跨服务器复制：选择一台已连接的服务器作为目标 */}
            <CrossCopyDialog
                open={copyOpen}
                paths={copyPaths}
                sourceSessionId={sessionId}
                onClose={() => setCopyOpen(false)}
                onConfirm={(target) => {
                    setCopyOpen(false);
                    handleCrossCopy(copyPaths, target);
                }}
            />

            {/* 传输队列：只展示当前会话的传输，避免多会话互相串台 */}
            <TransferQueue sessionId={sessionId} onRetry={handleRetryTransfer} />

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
                            <DropdownMenuItem onClick={() => { handlePreview(contextMenu.entry, contextMenu.fullPath); setContextMenu(null); }}>
                                <FileText className="size-4" /> {t("preview")}
                            </DropdownMenuItem>
                        )}
                        {!contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => {
                                void handleOpenExternalEditor(contextMenu.entry, contextMenu.fullPath);
                                setContextMenu(null);
                            }}>
                                <ExternalLink className="size-4" /> {t("open_external_editor")}
                            </DropdownMenuItem>
                        )}
                        {!contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => { handleDownload(contextMenu.entry, contextMenu.fullPath); setContextMenu(null); }}>
                                <Download className="size-4" /> {t("download")}
                            </DropdownMenuItem>
                        )}
                        {contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => {
                                void startArchiveDownload(
                                    [resolveEntryPath(contextMenu.entry, contextMenu.fullPath)],
                                    [contextMenu.entry.name],
                                );
                                setContextMenu(null);
                            }}>
                                <FileArchive className="size-4" /> {t("archive_download")}
                            </DropdownMenuItem>
                        )}
                        {contextMenu.entry.isDir && (
                            <DropdownMenuItem onClick={() => { handleCdToTerminal(contextMenu.entry, contextMenu.fullPath); setContextMenu(null); }}>
                                <SquareTerminal className="size-4" /> {t("open_in_terminal")}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => { handleInsertPath(contextMenu.entry, contextMenu.fullPath); setContextMenu(null); }}>
                            <SquareTerminal className="size-4" /> {t("insert_path_to_terminal")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                            setCopyPaths([resolveEntryPath(contextMenu.entry, contextMenu.fullPath)]);
                            setCopyOpen(true);
                            setContextMenu(null);
                        }}>
                            <Server className="size-4" /> {t("copy_to_server")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { handleCopyPath(contextMenu.entry, contextMenu.fullPath); setContextMenu(null); }}>
                            <Copy className="size-4" /> {t("copy_path")}
                        </DropdownMenuItem>
                        {!contextMenu.entry.isDir && isArchiveName(contextMenu.entry.name) && (
                            <DropdownMenuItem onClick={() => {
                                void handleExtractArchive(
                                    resolveEntryPath(contextMenu.entry, contextMenu.fullPath),
                                    contextMenu.entry.name,
                                );
                                setContextMenu(null);
                            }}>
                                <FileArchive className="size-4" /> {t("extract_to_current")}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => { setRenameTarget(contextMenu.entry.name); setRenameValue(contextMenu.entry.name); setRenameOpen(true); contextMenuPathRef.current = contextMenu.fullPath ?? null; setContextMenu(null); }}>
                            <Pencil className="mr-2 size-4" /> {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                            setChmodTarget(contextMenu.entry.name);
                            setChmodValue(toOctal(contextMenu.entry.mode));
                            setChmodEntry(contextMenu.entry);
                            setChmodEntryPath(contextMenu.fullPath ?? joinPath(currentPath, contextMenu.entry.name));
                            setChmodOpen(true);
                            contextMenuPathRef.current = contextMenu.fullPath ?? null;
                            setContextMenu(null);
                        }}>
                            <Info className="mr-2 size-4" /> {t("properties")}
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

            {/* 文件属性：元信息 + 权限编辑（属性与 chmod 合并为一个卡片） */}
            <Dialog
                open={chmodOpen}
                onOpenChange={(open) => {
                    setChmodOpen(open);
                    if (!open) {
                        setChmodEntry(null);
                        setChmodEntryPath("");
                        contextMenuPathRef.current = null;
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("properties")}</DialogTitle>
                        <DialogDescription className="break-all">{chmodTarget}</DialogDescription>
                    </DialogHeader>

                    {chmodEntry && (
                        <div className="grid grid-cols-[auto,minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
                            <span className="text-[var(--fg-subtle)]">{t("property_type")}</span>
                            <span>{chmodEntry.isDir ? t("file_type_dir") : t("file_type_file")}</span>
                            <span className="text-[var(--fg-subtle)]">{t("property_size")}</span>
                            <span className="tabular-nums">{formatFileSize(chmodEntry.size)}</span>
                            <span className="text-[var(--fg-subtle)]">{t("property_modified")}</span>
                            <span className="tabular-nums">
                                {chmodEntry.modTime ? formatDateTime(chmodEntry.modTime) : "—"}
                            </span>
                            <span className="text-[var(--fg-subtle)]">{t("property_path")}</span>
                            <span className="break-all font-mono text-[11px] text-[var(--fg-muted)]">
                                {chmodEntryPath || chmodTarget}
                            </span>
                        </div>
                    )}

                    <div className="flex flex-col gap-2 border-t border-[var(--hairline)] pt-3">
                        <span className="text-[12px] text-[var(--fg-muted)]">{t("property_permissions")}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {["600", "644", "700", "755"].map((preset) => (
                                <button
                                    key={preset}
                                    type="button"
                                    onClick={() => setChmodValue(preset)}
                                    className={cn(
                                        "rounded-md border border-[var(--hairline)] px-2 py-1 font-mono text-[11px] transition-colors",
                                        chmodValue === preset
                                            ? "border-primary/50 bg-primary/10 text-primary"
                                            : "text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                                    )}
                                >
                                    {preset}
                                </button>
                            ))}
                        </div>
                        <Input
                            value={chmodValue}
                            onChange={(e) => setChmodValue(e.target.value)}
                            placeholder={t("chmod_prompt")}
                            autoFocus
                            className="font-mono"
                            onKeyDown={(e) => { if (e.key === "Enter") handleChmod(); }}
                        />
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setChmodOpen(false)}>{t("cancel", { ns: "common" })}</Button>
                        <Button onClick={handleChmod} disabled={!chmodValue.trim()}>{t("save")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 文件预览/编辑对话框 */}
            <Dialog open={previewOpen} onOpenChange={(v) => { if (v) setPreviewOpen(true); else requestClosePreview(); }}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {previewEditing ? t("edit_file") : t("preview")} - {previewEntry?.name}
                            {/* 未保存标记：让用户明确当前内容尚未写回远端 */}
                            {previewDirty && (
                                <span
                                    className="ml-1.5 align-middle text-[var(--warning)]"
                                    title={t("discard_changes_title")}
                                >
                                    ●
                                </span>
                            )}
                        </DialogTitle>
                    </DialogHeader>
                    {previewEditing ? (
                        <textarea
                            className="max-h-[60vh] min-h-[300px] w-full resize-y rounded-lg bg-[var(--surface-2)] p-3 font-mono text-xs leading-relaxed outline-none"
                            value={previewContent}
                            onChange={(e) => setPreviewContent(e.target.value)}
                            spellCheck={false}
                        />
                    ) : (
                        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-[var(--surface-2)] p-3 font-mono text-xs leading-relaxed">
                            {previewContent}
                        </pre>
                    )}
                    <DialogFooter className="gap-2">
                        {!previewEditing ? (
                            <Button variant="outline" onClick={() => setPreviewEditing(true)}>{t("edit")}</Button>
                        ) : (
                            <Button variant="default" onClick={handleSavePreview} disabled={previewSaving}>
                                {previewSaving ? t("saving") : t("save")}
                            </Button>
                        )}
                        <Button variant="outline" onClick={requestClosePreview}>{t("close", { ns: "common" })}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 未保存修改的关闭确认：关闭 / 切换标签等操作前先让用户确认 */}
            <ConfirmModal
                isOpen={discardPreviewOpen}
                onClose={() => setDiscardPreviewOpen(false)}
                onConfirm={closePreview}
                title={t("discard_changes_title")}
                description={t("discard_changes_desc", { name: previewEntry?.name ?? "" })}
                confirmText={t("discard_changes_confirm")}
                cancelText={t("discard_changes_cancel")}
            />

            {/* 删除确认弹窗 */}
            <ConfirmModal
                isOpen={deleteOpen}
                onClose={() => !isDeleting && setDeleteOpen(false)}
                onConfirm={handleDelete}
                title={t("delete")}
                description={t("delete_confirm", { name: deleteTarget })}
                confirmDisabled={isDeleting}
            />

            {/* 批量删除确认弹窗 */}
            <ConfirmModal
                isOpen={batchDeleteOpen}
                onClose={() => !isBatchDeleting && setBatchDeleteOpen(false)}
                onConfirm={handleBatchDelete}
                title={t("delete_selected_tip", { count: selectedNames.size })}
                description={t("delete_selected_confirm", { count: selectedNames.size })}
                confirmDisabled={isBatchDeleting}
            />

            {/* 上传同名冲突确认：确认覆盖，或"跳过"仅上传无冲突的文件 */}
            <ConfirmModal
                isOpen={uploadConflicts.length > 0}
                onClose={() => resolveUploadConflicts(false)}
                onConfirm={() => resolveUploadConflicts(true)}
                title={t("upload_conflict_title", { count: uploadConflicts.length })}
                description={t("upload_conflict_body", { names: conflictNames })}
                confirmText={t("upload_conflict_overwrite")}
                cancelText={t("upload_conflict_skip")}
                isDestructive={false}
            />

            {/* 下载覆盖确认：本地已有同名目标时提示，取消即不下载 */}
            <ConfirmModal
                isOpen={downloadConflicts.length > 0}
                onClose={() => resolveDownloadConflicts(false)}
                onConfirm={() => resolveDownloadConflicts(true)}
                title={t("download_conflict_title", { count: downloadConflicts.length })}
                description={t("download_conflict_body", { names: downloadConflictNames })}
                confirmText={t("download_conflict_overwrite")}
                isDestructive={false}
            />
        </div>
    );
}
