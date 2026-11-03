import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Events, Clipboard, Dialogs } from "@wailsio/runtime";
import { getTerminalTheme, resolveTerminalFontFamily, type TerminalAppearance } from "@/lib/terminalTheme";
import { parseAppError, handleAppError } from "@/lib/error";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
import { createFlowControlledWriter, setupScrollAnchoring } from "@/lib/terminalFlowControl";
import { createKeywordHighlighter, DEFAULT_KEYWORDS } from "@/lib/keywordHighlight";
import { createOsc7Parser } from "@/lib/osc7";
import { createTerminalSignalParser } from "@/lib/terminalSignals";
import { createTerminalDecoder, normalizeTerminalEncoding } from "@/lib/terminalEncoding";
import { ZmodemBridge, type ZmodemUploadFile } from "@/lib/zmodem";
import { formatFileSize } from "@/lib/format";
import { joinRemotePath, localBasename, quoteLocalPath, shellQuote, REMOTE_PATH_MIME } from "@/lib/remotePath";
import { sendSessionInput, sendSessionInputBase64, resizeSession } from "@/lib/sessionTransport";
import { closeTransport } from "@/lib/sessionBackend";
import { isTransferCanceled } from "@/lib/sftpEvents";
import { scheduleTransfer } from "@/lib/transferScheduler";
import { openExternalUrl, searchBing, searchGitHub } from "@/lib/openExternal";
import { showDesktopNotification } from "@/lib/desktopNotify";
import { matchesCombo } from "@/lib/shortcuts";
import { suggestCommands, buildSuggestionInput, type CommandSuggestion } from "@/lib/commandSuggestions";
import { clearRemoteHistory, loadRemoteShellHistory } from "@/lib/remoteHistory";
import "@xterm/xterm/css/xterm.css";
import { SSHConnectionConfig, SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { LocalShellService } from "../../../bindings/terminator-desktop/backend/internal/services/local";
import { Service as NetConnService, SerialConfig } from "../../../bindings/terminator-desktop/backend/internal/services/netconn";
import { TextFileService } from "../../../bindings/terminator-desktop/backend/internal/services/fileio";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { useSessionStore, isSessionDetached, type NetConnConfig, type SessionKind } from "@/store/sessionStore.ts";
import { useTransferStore } from "@/store/transferStore";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { X, ChevronUp, ChevronDown, Search, RotateCw, Highlighter, ExternalLink, GitBranch, Globe } from "lucide-react";
import { toast } from "sonner";

interface TerminalInstanceProps {
    sessionId: string;
    /** 是否可见：普通模式只有激活标签可见；分屏时两个窗格同时可见 */
    isVisible: boolean;
    /** 是否拥有焦点：决定输入、搜索浮层与高亮样式 */
    isFocused: boolean;
    config: SSHConnectionConfig;
    /** 会话来源：local 表示本机 shell，连接与输入走 LocalShellService */
    sessionKind?: SessionKind;
    /** Telnet / 串口连接参数（kind 为 telnet/serial 时使用） */
    netConn?: NetConnConfig;
    disconnected?: boolean;
    /** 连接成功后自动执行的命令 */
    onConnect?: string;
    /** 定位类名：普通标签为 inset-0，分屏窗格各占半幅 */
    className?: string;
    /** 分屏比例定位（覆盖 inset-0 的对应边） */
    style?: CSSProperties;
    /** 重连计数：变化时重新建立 SSH 连接并回放最近输出 */
    reconnectNonce?: number;
    /**
     * 附着到已存在的后端会话：首次挂载不建立新连接，只同步终端尺寸。
     * 浮动窗口弹出/收回会话时使用；显式重连（reconnectNonce 递增）仍会重新连接。
     */
    attachOnMount?: boolean;
}

/**
 * 读取当前终端外观设置
 * 初始化 effect 的依赖里不含外观字段（改动外观不应重建终端），
 * 因此这里统一走 getState，保证读到的始终是最新值。
 */
function readTerminalAppearance(): TerminalAppearance {
    const s = useUIStore.getState();
    return {
        fontSize: s.terminalFontSize,
        fontFamily: s.terminalFontFamily,
        lineHeight: s.terminalLineHeight,
        cursorStyle: s.terminalCursorStyle,
        cursorBlink: s.terminalCursorBlink,
        scrollback: s.terminalScrollback,
    };
}

/**
 * 搜索高亮选项
 * xterm 的 decoration 只接受 #RRGGBB（不支持透明度），
 * 因此选明暗两套主题上都可读的暖黄 / 橙色，并开启全量匹配高亮。
 */
const SEARCH_OPTIONS: ISearchOptions = {
    decorations: {
        matchBackground: "#fef08a",
        matchBorder: "#eab308",
        matchOverviewRuler: "#eab308",
        activeMatchBackground: "#fbbf24",
        activeMatchBorder: "#f59e0b",
        activeMatchColorOverviewRuler: "#f59e0b",
    },
};

/** 终端标题上报的最大长度：过长的标题会把标签栏挤爆 */
const TERM_TITLE_MAX = 80;

/**
 * 规范化 shell 上报的标题（OSC 0/2）。
 * 远端可以上报任意字节，控制字符会让标签渲染错乱，必须剥掉；
 * 连续空白压成一个空格，避免出现大片空白标签。
 */
function sanitizeTermTitle(raw: string): string {
    // 只保留可见字符，同时把控制字符替换成空格以免单词粘连
    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    return cleaned.length > TERM_TITLE_MAX ? cleaned.slice(0, TERM_TITLE_MAX) : cleaned;
}

export function TerminalInstance({sessionId, isVisible, isFocused, config, sessionKind, netConn, disconnected, onConnect, className, style, reconnectNonce, attachOnMount}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
    const isLocal = sessionKind === "local";
    // kind 缺省视为 SSH：旧会话与新增 SSH 会话都不写该字段
    const isSsh = sessionKind === undefined || sessionKind === "ssh";
    const isTelnet = sessionKind === "telnet";
    const isSerial = sessionKind === "serial";
    // ZMODEM 需要远端 shell 支持 rz/sz；串口没有命令通道，不启用
    const supportsZmodem = isSsh || isTelnet;
    // 会话字符编码：SSH 来自主机高级参数，Telnet / 串口来自连接配置。
    // 非 UTF-8 时输出需先解码为字符串再交给 xterm（xterm 只按 UTF-8 解释字节）。
    const sessionEncoding = normalizeTerminalEncoding(
        isSsh ? config.encoding : netConn?.encoding,
    );
    const theme = useUIStore((s) => s.theme);
    const accentColor = useUIStore((s) => s.accentColor);
    const skin = useUIStore((s) => s.skin);
    const terminalColorLink = useUIStore((s) => s.terminalColorLink);
    const terminalColorScheme = useUIStore((s) => s.terminalColorScheme);
    const customTerminalColors = useUIStore((s) => s.customTerminalColors);
    // 终端外观字段需要参与渲染：变化时触发下面的热更新 effect
    const terminalFontSize = useUIStore((s) => s.terminalFontSize);
    const terminalFontFamily = useUIStore((s) => s.terminalFontFamily);
    const terminalCursorStyle = useUIStore((s) => s.terminalCursorStyle);
    const terminalCursorBlink = useUIStore((s) => s.terminalCursorBlink);
    const terminalLineHeight = useUIStore((s) => s.terminalLineHeight);
    const terminalScrollback = useUIStore((s) => s.terminalScrollback);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const commandSuggestions = useUIStore((s) => s.commandSuggestions);
    const setSessionStatus = useSessionStore((s) => s.setSessionStatus);

    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const serializeRef = useRef<SerializeAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const flowWriterRef = useRef<ReturnType<typeof createFlowControlledWriter> | null>(null);
    const scrollAnchorRef = useRef<ReturnType<typeof setupScrollAnchoring> | null>(null);
    // 关键词高亮处理器，在终端初始化时创建，随终端销毁而释放
    const keywordHighlighterRef = useRef<ReturnType<typeof createKeywordHighlighter> | null>(null);
    const hasConnectedRef = useRef(false);
    // 本地终端实际使用的 shell：拖拽文件名引用需要按 shell 语法转义
    // （PowerShell 双引号内会执行 $(...)，必须用单引号）。
    const localShellRef = useRef("");
    const isReadyRef = useRef(false);
    // 断线提示是否已输出，避免同一会话重复打印
    const disconnectNotifiedRef = useRef(false);
    // 可见性用于决定是否向后端同步终端尺寸：隐藏标签不参与布局，
    // 若仍发送 Resize 会把其后端 PTY 缩成与隐藏容器一致的尺寸。
    const isVisibleRef = useRef(isVisible);
    isVisibleRef.current = isVisible;
    // 重连时用于回放最近的终端输出（避免会话恢复后一片空白）
    const savedBufferRef = useRef("");
    // OSC 7 目录上报解析器（SFTP 跟随终端目录）
    const osc7ParserRef = useRef<ReturnType<typeof createOsc7Parser> | null>(null);
    // 通知 / 命令结束信号解析器（OSC 9 / 777 / 133）
    const signalParserRef = useRef<ReturnType<typeof createTerminalSignalParser> | null>(null);
    // 通知节流：同一终端短时间内大量 OSC 通知时只提示一次
    const lastNotifyAtRef = useRef(0);
    // 自动重连计数与定时器：最多 3 次，指数退避
    const reconnectAttemptsRef = useRef(0);
    const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 连接链：把 Connect / Disconnect 串行化。重连时旧会话的 Disconnect
    // 若晚于新连接落地，会按同一个会话 ID 把刚建立的新会话误删。
    const connectChainRef = useRef<Promise<unknown>>(Promise.resolve());
    // ZMODEM 桥接器：拦截终端字节流中的 ZMODEM 协议数据（仅 SSH 会话）
    const zmodemBridgeRef = useRef<ZmodemBridge | null>(null);
    // 普通输出写入函数：由输出事件 effect 赋值，ZMODEM 桥接器通过它把
    // 非协议数据交回统一管线（OSC 解析、关键词高亮、流控写入）
    const writeOutputRef = useRef<(bytes: Uint8Array) => void>(() => {});
    // 遗留编码的流式解码器（UTF-8 会话为 null）
    const decoderRef = useRef<TextDecoder | null>(null);

    // 多行粘贴确认
    const [pendingPaste, setPendingPaste] = useState<string | null>(null);
    // 终端是否有选中文本（用于"高亮所选"与划词搜索快捷操作）
    const [hasSelection, setHasSelection] = useState(false);
    const [selectionText, setSelectionText] = useState("");
    // 命令行补全：追踪当前输入行并展示建议列表（仅 SSH 会话、普通屏幕缓冲区）
    const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
    const suggestionsRef = useRef<CommandSuggestion[]>([]);
    const inputLineRef = useRef("");
    // 行内 ghost 建议：在光标位置叠加显示首条建议的剩余部分
    const [ghost, setGhost] = useState<{ text: string; left: number; top: number; height: number; maxWidth: number } | null>(null);
    // 本地跟踪的输入行是否与远端 shell 的实际行一致：一旦发生光标移动、
    // 历史翻页或远端补全，就不能再用它计算退格数量
    const lineTrustedRef = useRef(true);
    // 文件拖拽上传状态
    const [isDragOver, setIsDragOver] = useState(false);
    const addTransfer = useTransferStore((s) => s.addTransfer);
    const updateTransfer = useTransferStore((s) => s.updateTransfer);

    // 搜索面板状态
    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    // 命中计数：由 SearchAddon.onDidChangeResults 回填，用于显示 n/m
    const [searchResults, setSearchResults] = useState({ index: -1, count: 0 });
    const searchInputRef = useRef<HTMLInputElement>(null);
    // 右键菜单位置（视口坐标），null 表示菜单关闭
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    // 用 ref 跟踪 showSearch 最新值，供 attachCustomKeyEventHandler 闭包使用
    const showSearchRef = useRef(showSearch);
    showSearchRef.current = showSearch;

    // 本地终端记录实际 shell，供拖拽路径按正确语法转义
    useEffect(() => {
        if (!isLocal) return;
        LocalShellService.DefaultShell()
            .then((shell) => {
                localShellRef.current = shell;
            })
            .catch(() => {});
    }, [isLocal]);

    const printErrorToTerminal = (error: unknown) => {
        if (!terminalRef.current) return;
        const appError = parseAppError(error);
        const translated = t("error_message", { message: appError.message, error: appError.detailsString })
        terminalRef.current.write(`\r\n\x1b[31m${translated}\x1b[0m\r\n`)
    };

    /**
     * 统一输入出口：先发往当前会话，广播模式下再发送到其他未排除的活跃会话。
     * 命令行补全接受建议时也走这里，保证广播模式同样生效。
     *
     * 本地终端不参与广播（与状态栏只对非本地会话显示广播标识保持一致）：
     * 本地 shell 与远端 shell 的命令语义完全不同，把本地输入灌到生产服务器、
     * 或把远端命令落到本地 shell 都可能直接执行破坏性操作。
     */
    const sendInputWithBroadcast = (data: string) => {
        sendSessionInput(sessionId, data, sessionKind).catch(printErrorToTerminal);
        if (isLocal) return;
        const state = useSessionStore.getState();
        if (!state.broadcastMode) return;
        const targets = state.sessions.filter((session) =>
            session.id !== sessionId
            && (session.kind ?? "ssh") !== "local"
            && session.status === "connected"
            && !session.disconnected
            && !state.broadcastExcluded.includes(session.id)
        );
        for (const target of targets) {
            // 带上门标的 kind：广播目标可能是 Telnet / 串口，不能按默认 SSH 路由
            sendSessionInput(target.id, data, target.kind).catch(() => {});
        }
    };

    /** 收起补全面板（不清空本地行状态） */
    const hideCommandSuggestions = () => {
        if (suggestionsRef.current.length > 0) {
            suggestionsRef.current = [];
            setSuggestions([]);
        }
    };

    /**
     * 放弃当前行的跟踪。
     * 历史翻页、光标移动、远端补全等操作会改变 shell 的行内容，而终端
     * 无法可靠还原，此时必须停止补全，避免之后按错误的字符数发送退格。
     */
    const abandonCommandLine = () => {
        inputLineRef.current = "";
        lineTrustedRef.current = false;
        hideCommandSuggestions();
        setGhost(null);
    };

    /**
     * 计算行内 ghost 建议的位置：取首条建议相对当前输入行的剩余后缀，
     * 叠加显示在光标右侧（与 zsh-autosuggestions 的视觉一致）。
     */
    const updateGhostHint = () => {
        const term = terminalRef.current;
        const container = containerRef.current;
        const top = suggestionsRef.current[0];
        if (!useUIStore.getState().commandSuggestions || !term || !container || !top) {
            setGhost(null);
            return;
        }
        if (term.buffer.active.type === "alternate") {
            setGhost(null);
            return;
        }
        const suffix = top.text.slice(inputLineRef.current.length);
        if (!suffix) {
            setGhost(null);
            return;
        }
        const screen = container.querySelector<HTMLElement>(".xterm-screen");
        if (!screen || term.cols <= 0 || term.rows <= 0) {
            setGhost(null);
            return;
        }
        const cellWidth = screen.clientWidth / term.cols;
        const cellHeight = screen.clientHeight / term.rows;
        if (cellWidth <= 0 || cellHeight <= 0) {
            setGhost(null);
            return;
        }
        // 覆盖层挂在终端根节点里（容器带内边距）：用两者的偏移换算坐标
        const root = container.parentElement ?? container;
        const rootRect = root.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        const buffer = term.buffer.active;
        const left = screenRect.left - rootRect.left + buffer.cursorX * cellWidth;
        const topPx = screenRect.top - rootRect.top + buffer.cursorY * cellHeight;
        setGhost({
            text: suffix,
            left,
            top: topPx,
            height: cellHeight,
            maxWidth: Math.max(0, rootRect.width - left - 8),
        });
    };

    /**
     * 记录当前输入行并计算补全建议。
     * 只跟踪单行可打印 ASCII；换行后重新建立可信状态。可信状态一旦丢失，
     * 本行不再提供建议（下一次回车后恢复）。
     */
    const trackCommandInput = (data: string) => {
        // 补全依赖远端历史与 shell 语法：仅 SSH 会话启用
        if (!isSsh) return;
        if (!useUIStore.getState().commandSuggestions) {
            // 关闭期间没有记录输入，重新开启后当前行内容不可知
            abandonCommandLine();
            return;
        }
        const term = terminalRef.current;
        if (!term || term.buffer.active.type === "alternate") {
            abandonCommandLine();
            return;
        }
        if (/[\r\n]/.test(data)) {
            // 回车后是一行全新的空输入，重新建立可信状态
            inputLineRef.current = "";
            lineTrustedRef.current = true;
            hideCommandSuggestions();
            setGhost(null);
            return;
        }
        if (!lineTrustedRef.current) return;
        if (data === "\u007f" || data === "\b") {
            inputLineRef.current = [...inputLineRef.current].slice(0, -1).join("");
        } else if (data.startsWith("\x1b") || data === "\t"
            || data === "\x03" || data === "\x15" || data === "\x0b" || data === "\x17") {
            abandonCommandLine();
            return;
        } else if (/^[\x20-\x7e]+$/.test(data)) {
            inputLineRef.current = (inputLineRef.current + data).slice(-1024);
        } else {
            abandonCommandLine();
            return;
        }

        const next = suggestCommands(inputLineRef.current, 6, sessionId);
        const previous = suggestionsRef.current;
        if (next.length === 0) {
            if (previous.length > 0) {
                suggestionsRef.current = [];
                setSuggestions([]);
            }
            setGhost(null);
            return;
        }
        // 列表内容未变化时不触发重渲染
        const unchanged = previous.length === next.length
            && previous.every((item, index) => item.text === next[index].text);
        if (unchanged) return;
        suggestionsRef.current = next;
        setSuggestions(next);
        updateGhostHint();
    };

    /** 接受补全建议：用退格清除已输入部分，再发送建议剩余内容 */
    const acceptCommandSuggestion = (item: CommandSuggestion) => {
        const payload = buildSuggestionInput(inputLineRef.current, item.text);
        if (!payload || !lineTrustedRef.current) {
            abandonCommandLine();
            return;
        }
        // 内置命令补一个空格，方便直接继续输入参数
        const completed = item.text + (item.source === "builtin" ? " " : "");
        inputLineRef.current = completed;
        suggestionsRef.current = [];
        setSuggestions([]);
        setGhost(null);
        sendInputWithBroadcast(payload + (item.source === "builtin" ? " " : ""));
        terminalRef.current?.focus();
    };

    // 粘贴入口：多行内容在开启保护时先弹确认，避免把整段脚本误灌进生产环境
    const pasteIntoTerminal = (text: string) => {
        if (!text || !terminalRef.current || !isReadyRef.current) return;
        // 只要含换行就要确认：单行 "rm -rf /x\n" 的末尾换行会让远端立即执行，
        // 按非空行数统计会漏掉这种最常见的高危情形。
        if (useUIStore.getState().pasteProtection && /[\r\n]/.test(text)) {
            setPendingPaste(text);
            return;
        }
        terminalRef.current.paste(text);
    };

    // ---- 终端右键菜单动作 ----
    const closeContextMenu = () => {
        setContextMenu(null);
        // 关闭菜单后把焦点还给终端，保证键盘输入立即可用
        terminalRef.current?.focus();
    };

    /** 复制当前选区 */
    const copySelection = () => {
        const selection = terminalRef.current?.getSelection();
        if (selection) Clipboard.SetText(selection).catch(console.error);
    };

    /** 粘贴剪贴板文本：多行内容仍走粘贴保护确认 */
    const pasteFromClipboard = () => {
        Clipboard.Text().then((text) => {
            if (text) pasteIntoTerminal(text);
        }).catch(console.error);
    };

    /** 打开搜索框并聚焦输入框 */
    const openSearchPanel = () => {
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
    };

    /** 打开命令草稿栏（多行编辑后统一发送） */
    const openComposePanel = () => {
        useUIStore.getState().setComposePanelVisible(true);
    };

    /**
     * 保存终端缓冲区
     * SerializeAddon 默认会导出全部回滚缓冲，这里序列化后写入用户在
     * 系统保存对话框中选择的路径。
     */
    const saveTerminalBuffer = async () => {
        const serializer = serializeRef.current;
        if (!serializer) return;
        let content = "";
        try {
            content = serializer.serialize();
        } catch (err) {
            handleAppError(err);
            return;
        }
        if (!content.trim()) {
            toast.info(t("ctx_save_empty"));
            return;
        }
        // 文件名取标签标题：过滤 Windows 路径非法字符并限长，
        // 追加本地时间戳避免连续导出互相覆盖
        const title = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.title ?? "";
        const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().slice(0, 40);
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
            + `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        try {
            const path = await Dialogs.SaveFile({
                Title: t("ctx_save_buffer"),
                Filename: `${safeTitle || "terminal"}-${stamp}.txt`,
            });
            if (!path) return; // 用户取消保存
            await TextFileService.SaveText(path, content);
            toast.success(t("ctx_save_success"));
        } catch (err) {
            // 关闭保存对话框时 wails 会抛出 "cancelled by user"，不是错误
            if (/cancel/i.test(String((err as Error)?.message ?? err))) return;
            handleAppError(err);
        }
    };

    // ZMODEM 上传：先选好本地文件再在远端执行 rz，桥接器检测到 ZRINIT 后开始传输。
    // 选择文件放在命令之前：远端 rz 只等待很短时间，先读文件可避免其超时退出。
    const handleZmodemUpload = async () => {
        const bridge = zmodemBridgeRef.current;
        if (!bridge) {
            toast.error(t("zmodem_unavailable"));
            return;
        }
        if (bridge.isActive()) {
            toast.error(t("zmodem_busy"));
            return;
        }
        if (!isReadyRef.current) {
            toast.error(t("zmodem_not_ready"));
            return;
        }
        try {
            const picked = await Dialogs.OpenFile({
                Title: t("zmodem_upload"),
                CanChooseFiles: true,
                CanChooseDirectories: false,
                AllowsMultipleSelection: true,
            });
            const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
            if (paths.length === 0) return;
            const files: ZmodemUploadFile[] = [];
            for (const path of paths) {
                const encoded = await TextFileService.ReadBinary(path);
                files.push({name: localBasename(path), bytes: decodeBase64ToUint8Array(encoded)});
            }
            bridge.queueUpload(files);
            // \x15 清空当前输入行：避免 rz 拼接在用户正在输入的命令之后
            await sendSessionInput(sessionId, "\x15rz\r", sessionKind);
        } catch (err) {
            // 关闭文件选择框时 wails 会抛出 "cancelled by user"，不是错误
            if (/cancel/i.test(String((err as Error)?.message ?? err))) return;
            handleAppError(err);
        }
    };

    // 终端初始化（sessionId/config 变化或重连时重新执行）
    useEffect(() => {
        if (!containerRef.current || terminalRef.current) return;
        const container = containerRef.current;

        // 新会话/重连后本地行跟踪从空行重新开始
        inputLineRef.current = "";
        lineTrustedRef.current = true;

        let cancelled = false;

        const term = new Terminal(getTerminalTheme(
            theme,
            terminalColorLink ? accentColor : undefined,
            skin,
            readTerminalAppearance(),
            useUIStore.getState().terminalColorScheme,
            useUIStore.getState().customTerminalColors,
        ));
        const fitAddon = new FitAddon();
        const unicode11Addon = new Unicode11Addon();
        const serializeAddon = new SerializeAddon();
        const searchAddon = new SearchAddon();
        // 终端内 URL 可点击：交给系统浏览器，不在应用内打开
        const webLinksAddon = new WebLinksAddon((event, uri) => {
            event.preventDefault();
            openExternalUrl(uri);
        });

        term.loadAddon(fitAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(serializeAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(webLinksAddon);
        term.unicode.activeVersion = "11";
        term.open(container);

        // 重连场景：把上一次会话的尾部输出回放到新终端，保留上下文
        if (savedBufferRef.current) {
            term.write(savedBufferRef.current);
            savedBufferRef.current = "";
        }

        // 解析 shell 上报的当前目录，供 SFTP 面板跟随
        osc7ParserRef.current = createOsc7Parser((path) => {
            useSessionStore.getState().setSessionCwd(sessionId, path);
        });

        // 跟随 shell 上报的标签标题（OSC 0/2）：多数 shell 的提示符配置会
        // 上报 "user@host: cwd"，比固定的主机名更能反映当前所在位置。
        // 用户手动重命名过的标签由 store 端锁定，这里不会覆盖。
        const titleDisposable = term.onTitleChange((title) => {
            const clean = sanitizeTermTitle(title);
            if (clean) {
                useSessionStore.getState().setSessionTermTitle(sessionId, clean);
            }
        });

        // 解析终端通知与命令结束标记（OSC 9 / 777 / 133）
        signalParserRef.current = createTerminalSignalParser({
            onNotify: (title, body) => {
                if (!useUIStore.getState().completionNotify) return;
                const now = Date.now();
                if (now - lastNotifyAtRef.current < 1500) return;
                lastNotifyAtRef.current = now;
                const toastTitle = title || t("notify_terminal_title");
                toast.message(toastTitle, { description: body });
                if (document.hidden) showDesktopNotification(toastTitle, body);
            },
            onCommandDone: (exitCode) => {
                const store = useSessionStore.getState();
                store.markSessionDone(sessionId);
                if (!useUIStore.getState().completionNotify) return;
                // 当前正在查看的标签不打扰用户
                if (store.activeSessionId === sessionId && !document.hidden) return;
                const now = Date.now();
                if (now - lastNotifyAtRef.current < 1500) return;
                lastNotifyAtRef.current = now;
                const title = t("notify_command_done_title");
                const body = exitCode === null
                    ? t("notify_command_done_body")
                    : t("notify_command_done_exit", {code: exitCode});
                toast.message(title, { description: body });
                if (document.hidden) showDesktopNotification(title, body);
            },
        });

        // 尝试加载 WebGL 渲染器，失败时回退到默认 canvas 渲染器
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
                try {
                    term.refresh(0, term.rows - 1);
                } catch {
                    // 终端可能已销毁
                }
            });
            term.loadAddon(webglAddon);
        } catch {
            // WebGL 不可用时静默回退到 canvas 渲染
        }

        terminalRef.current = term;
        fitAddonRef.current = fitAddon;
        serializeRef.current = serializeAddon;
        searchAddonRef.current = searchAddon;
        // 命中计数订阅：面板显示 n/m，关闭面板或清空关键词时归零
        const searchResultsDisposable = searchAddon.onDidChangeResults((e) => {
            setSearchResults({ index: e.resultIndex, count: e.resultCount });
        });

        // 初始化流控写入器和滚动锚定
        flowWriterRef.current = createFlowControlledWriter(term);
        scrollAnchorRef.current = setupScrollAnchoring(term, container);
        // 非 UTF-8 会话：流式解码远端字节，跨包的多字节字符不会撕裂
        decoderRef.current = createTerminalDecoder(sessionEncoding);

        // ZMODEM 桥接器：把 rz/sz 的协议字节从终端流中分离出来。
        // 下载自动识别 zmodem 头并弹保存框；上传由右键菜单先选文件再发送 rz。
        zmodemBridgeRef.current?.dispose();
        zmodemBridgeRef.current = supportsZmodem ? new ZmodemBridge({
            writeToTerminal: (bytes) => {
                writeOutputRef.current(bytes);
            },
            sendToRemote: (base64) => {
                // SSH 与 Telnet 都可能承载 ZMODEM，按会话 kind 路由原始字节
                sendSessionInputBase64(sessionId, base64, sessionKind).catch(() => {});
            },
            pickSavePath: async (name) => {
                try {
                    const path = await Dialogs.SaveFile({Title: t("zmodem_save_title"), Filename: name});
                    return path || null;
                } catch (err) {
                    if (!/cancel/i.test(String((err as Error)?.message ?? err))) handleAppError(err);
                    return null;
                }
            },
            saveBinary: (path, base64) => TextFileService.SaveBinary(path, base64),
            onEvent: (event) => {
                switch (event.kind) {
                    case "download-start":
                        toast.message(t("zmodem_download_start", {name: event.name}));
                        break;
                    case "download-done":
                        toast.success(t("zmodem_download_done", {
                            name: event.name,
                            size: formatFileSize(event.size),
                        }));
                        break;
                    case "download-skipped":
                        toast.info(t("zmodem_download_skipped", {name: event.name}));
                        break;
                    case "upload-start":
                        toast.message(t("zmodem_upload_started", {count: event.count}));
                        break;
                    case "upload-done":
                        toast.success(t("zmodem_upload_done", {
                            count: event.count,
                            skipped: event.skipped > 0 ? t("zmodem_skipped_suffix", {count: event.skipped}) : "",
                        }));
                        break;
                    case "canceled":
                        toast.info(t("zmodem_canceled"));
                        break;
                }
            },
            onError: (message) => toast.error(t("zmodem_error"), {description: message}),
        }) : null;
        // 初始化关键词高亮处理器（内部维护 TextDecoder stream 状态）。
        // 自定义规则通过 getter 实时读取，修改规则后无需重建终端。
        keywordHighlighterRef.current = createKeywordHighlighter(
            DEFAULT_KEYWORDS,
            () => useUIStore.getState().highlightRules,
        );
        // 选中文本时显示"高亮所选"与划词搜索快捷操作
        // 开启"选中即复制"后，拖选结束自动写入剪贴板（150ms 防抖，
        // 避免拖动过程中每移动一个字符就写一次系统剪贴板）
        let copySelectionTimer: ReturnType<typeof setTimeout> | null = null;
        const selectionDisposable = term.onSelectionChange(() => {
            const selection = term.getSelection().trim();
            // 仅空白选区不显示操作浮层：此时没有可搜索/可高亮的内容
            setHasSelection(!!selection);
            setSelectionText(selection.slice(0, 2048));
            if (!useUIStore.getState().copyOnSelect || !selection) return;
            if (copySelectionTimer) clearTimeout(copySelectionTimer);
            copySelectionTimer = setTimeout(() => {
                if (cancelled) return;
                const current = term.getSelection().trim();
                if (current) Clipboard.SetText(current).catch(console.error);
            }, 150);
        });

        term.attachCustomKeyEventHandler((arg) => {
            if (arg.type === "keydown") {
                // Ctrl+Shift+C 复制
                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyC") {
                    arg.preventDefault();
                    const selection = term.getSelection();
                    if (selection) {
                        Clipboard.SetText(selection).catch(console.error);
                    }
                    return false;
                }

                // Ctrl+Shift+V 粘贴
                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyV") {
                    arg.preventDefault();
                    Clipboard.Text().then((text) => {
                        if (text) pasteIntoTerminal(text);
                    }).catch(console.error);
                    return false;
                }

                // 命令行补全：仅在建议列表可见时接管 Tab / → / Esc。
                // 没有建议时全部交给远端 shell，保留原生路径与参数补全能力。
                if (suggestionsRef.current.length > 0
                    && !arg.ctrlKey && !arg.altKey && !arg.metaKey) {
                    if (arg.code === "Tab") {
                        arg.preventDefault();
                        acceptCommandSuggestion(suggestionsRef.current[0]);
                        return false;
                    }
                    if (arg.code === "ArrowRight" && !arg.shiftKey) {
                        arg.preventDefault();
                        acceptCommandSuggestion(suggestionsRef.current[0]);
                        return false;
                    }
                    if (arg.code === "Escape") {
                        arg.preventDefault();
                        abandonCommandLine();
                        return false;
                    }
                }

                // 标签导航（与 Windows Terminal / Termius 一致）：
                // Ctrl+Tab / Ctrl+Shift+Tab 循环切换，Ctrl+PageUp / Ctrl+PageDown 左右切换。
                // 这些组合在 shell 里没有通用语义，拦截后不影响常规输入。
                if (arg.ctrlKey && (arg.code === "Tab" || arg.code === "PageUp" || arg.code === "PageDown")) {
                    arg.preventDefault();
                    const direction: 1 | -1 =
                        arg.code === "PageUp" || (arg.code === "Tab" && arg.shiftKey) ? -1 : 1;
                    useSessionStore.getState().activateAdjacentSession(sessionId, direction);
                    return false;
                }

                // 搜索快捷键可在设置中修改
                if (matchesCombo(arg, useUIStore.getState().shortcuts.search)) {
                    arg.preventDefault();
                    setShowSearch(true);
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                    return false;
                }

                // Esc 关闭搜索面板
                if (arg.code === "Escape" && showSearchRef.current) {
                    setShowSearch(false);
                    setSearchQuery("");
                    setSearchResults({ index: -1, count: 0 });
                    searchAddonRef.current?.clearDecorations();
                    return false;
                }
            }
            return true;
        });

        // 右键弹出上下文菜单：复制/粘贴/全选/查找/保存输出/草稿栏。
        // 不再沿用"有选区就复制、无选区就粘贴"的隐式行为——菜单能明确列出
        // 可用动作，也避免误把剪贴板内容直接灌进远端。
        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
        };
        container.addEventListener("contextmenu", handleContextMenu);

        // Ctrl+V / 中键粘贴由 xterm 直接在隐藏 textarea 上接收并写进 PTY，
        // 不经过 pasteIntoTerminal；在容器捕获阶段先拦下多行内容，
        // 让粘贴保护对"菜单/快捷键"和"原生粘贴"两种入口都生效。
        const handleNativePaste = (e: ClipboardEvent) => {
            const text = e.clipboardData?.getData("text/plain") ?? "";
            if (!text || !/[\r\n]/.test(text)) return;
            if (!useUIStore.getState().pasteProtection) return;
            e.preventDefault();
            e.stopPropagation();
            setPendingPaste(text);
        };
        container.addEventListener("paste", handleNativePaste, true);

        // Ctrl + 滚轮缩放字号（VS Code / Windows Terminal 习惯）。
        // 只改 store，热更新 effect 会统一应用并重新 fit，避免两处逻辑不一致。
        const handleWheel = (e: WheelEvent) => {
            if (!e.ctrlKey || e.deltaY === 0) return;
            e.preventDefault();
            const ui = useUIStore.getState();
            ui.setTerminalFontSize(ui.terminalFontSize + (e.deltaY < 0 ? 1 : -1));
        };
        container.addEventListener("wheel", handleWheel, { passive: false });

        // 连接成功后自动执行主机配置的初始化命令。延迟一小段等远端 shell
        // 提示符就绪，避免命令与登录横幅的输出交叠或被丢弃。
        let onConnectTimer: ReturnType<typeof setTimeout> | null = null;

        // 附着模式：会话已在后端运行（会话从主窗口移入浮动窗口、或收回标签栏），
        // 首次挂载只建立视图，不重连；用户显式重连（nonce 变化）时才走完整连接流程。
        const attachExisting = !!attachOnMount && (reconnectNonce ?? 0) === 0;

        if (!hasConnectedRef.current) {
            setSessionStatus(sessionId, "connecting");
            // Connect 排在上一次 Disconnect 之后执行；组件卸载/重连时再把新的
            // Disconnect 追加到链尾，保证"先断旧、再连新、必要时再断"的顺序。
            const connectTask = connectChainRef.current.then(() => {
                if (cancelled || attachExisting) return;
                if (isLocal) return LocalShellService.Start(sessionId, "");
                if (isTelnet) {
                    return NetConnService.OpenTelnet(
                        sessionId,
                        netConn?.host ?? config.host,
                        netConn?.port ?? config.port,
                        sessionEncoding,
                    );
                }
                if (isSerial) {
                    if (!netConn?.serial) throw new Error(t("netconn_missing_config"));
                    // 编码统一由 netConn.encoding 提供，避免串口参数里残留旧值
                    return NetConnService.OpenSerial(
                        sessionId,
                        new SerialConfig({...netConn.serial, encoding: sessionEncoding}),
                    );
                }
                return SshService.Connect(config);
            });
            connectChainRef.current = connectTask.catch(() => {});
            connectTask
                .then(() => {
                    if (cancelled) return;
                    isReadyRef.current = true;
                    hasConnectedRef.current = true;
                    reconnectAttemptsRef.current = 0;
                    setSessionStatus(sessionId, "connected");
                    // 读取远端 shell 历史作为补全数据源；仅 SSH 会话可用，失败不影响连接
                    if (isSsh) void loadRemoteShellHistory(sessionId);
                    if (terminalRef.current && fitAddonRef.current) {
                        fitAddonRef.current.fit();
                        resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols, sessionKind)
                            .catch(console.error);
                    }
                    const command = onConnect?.trim();
                    if (command) {
                        onConnectTimer = setTimeout(() => {
                            if (cancelled || !isReadyRef.current) return;
                            sendSessionInput(sessionId, command.replace(/\r\n/g, "\n") + "\n", sessionKind)
                                .catch(printErrorToTerminal);
                        }, 400);
                    }
                })
                .catch((err) => {
                    if (cancelled) return;
                    setSessionStatus(sessionId, "disconnected");
                    printErrorToTerminal(err);
                    // 主机密钥变更属于需要用户介入的安全事件：仅打印原始错误
                    // 用户无法知道如何处理，这里补一条可操作的指引。
                    if (parseAppError(err).message.includes("has changed")) {
                        terminalRef.current?.write(`\x1b[33m${t("host_key_changed_hint")}\x1b[0m\r\n`);
                    }
                });
        }

        const onDataDisposable = term.onData((data) => {
            if (!isReadyRef.current) return;
            // ZMODEM 传输期间键盘输入会破坏协议字节流：仅允许 Esc/Ctrl-C 中止，
            // 其余按键直接丢弃，传输结束后自动恢复输入。
            if (zmodemBridgeRef.current?.isActive()) {
                if (data === "\x1b" || data === "\x03") zmodemBridgeRef.current.abort();
                return;
            }
            // 先更新本地输入行：命令行补全依赖它来计算建议
            trackCommandInput(data);
            sendInputWithBroadcast(data);
        });

        // 远端回声到达后光标才真正右移：用光标移动事件重新定位 ghost，
        // 否则覆盖层会停在刚输入字符的左侧。
        const cursorMoveDisposable = term.onCursorMove(() => {
            if (suggestionsRef.current.length > 0) updateGhostHint();
        });
        // 滚动会改变光标相对视口的位置，先隐藏 ghost，下次输入时重新计算
        const scrollDisposable = term.onScroll(() => setGhost(null));

        // 防抖 resize：fit() + Resize 一起延迟执行
        // 避免拖拽面板宽度时大量 fit() 调用导致闪烁和卡顿
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!fitAddonRef.current || !terminalRef.current) return;
                try {
                    fitAddonRef.current.fit();
                } catch {
                    return;
                }
                if (!isReadyRef.current || !terminalRef.current) return;
                if (isVisibleRef.current) {
                    resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols, sessionKind)
                        .catch(() => {});
                }
                // 尺寸变化后光标像素位置失效，隐藏 ghost，下次输入重新计算
                setGhost(null);
            }, 150);
        });
        resizeObserver.observe(container);

        return () => {
            cancelled = true;
            if (onConnectTimer) clearTimeout(onConnectTimer);
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
            container.removeEventListener("contextmenu", handleContextMenu);
            container.removeEventListener("paste", handleNativePaste, true);
            container.removeEventListener("wheel", handleWheel);
            zmodemBridgeRef.current?.dispose();
            zmodemBridgeRef.current = null;
            onDataDisposable.dispose();
            cursorMoveDisposable.dispose();
            scrollDisposable.dispose();
            selectionDisposable.dispose();
            titleDisposable.dispose();
            abandonCommandLine();
            // 会话卸载/重连时清理远端历史缓存：重连后会重新读取最新内容
            clearRemoteHistory(sessionId);
            if (copySelectionTimer) clearTimeout(copySelectionTimer);
            searchResultsDisposable.dispose();
            setHasSelection(false);
            setSelectionText("");
            // 重连前保存尾部输出：serialize 会包含全部 scrollback，
            // 这里截取末尾一段，既保留上下文又避免长会话占用过多内存。
            // 先 flush 流式解码器，否则最后一个不完整字符不会进入快照
            if (decoderRef.current) {
                try {
                    const tail = decoderRef.current.decode();
                    if (tail) term.write(tail);
                } catch {
                    // 解码器状态异常时跳过，不能阻断后续序列化
                }
            }
            if (serializeRef.current) {
                try {
                    const snapshot = serializeRef.current.serialize();
                    savedBufferRef.current = snapshot.length > 120_000
                        ? snapshot.slice(-120_000)
                        : snapshot;
                } catch {
                    savedBufferRef.current = "";
                }
            }
            osc7ParserRef.current = null;
            signalParserRef.current = null;
            decoderRef.current = null;
            scrollAnchorRef.current?.cleanup();
            scrollAnchorRef.current = null;
            flowWriterRef.current?.reset();
            flowWriterRef.current = null;
            keywordHighlighterRef.current = null;
            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            serializeRef.current = null;
            searchAddonRef.current = null;
            hasConnectedRef.current = false;
            isReadyRef.current = false;
            // 不在 cleanup 里把会话标记为 disconnected：重连时 cleanup 会先于
            // 新连接执行，若标记断开会再次触发自动重连，形成重复连接。
            // 真正的断线由 SshClosed 事件与连接失败分支标记。
            // 附着模式下会话的生命周期归窗口（而非本视图）所有：
            // 视图卸载不关闭连接，窗口关闭时由后端统一释放。
            // 移入浮动窗口的会话同理：标签被移除只代表视图消失，连接仍在浮动窗口中运行。
            if (!attachExisting && !isSessionDetached(sessionId)) {
                connectChainRef.current = connectChainRef.current.then(() =>
                    closeTransport(sessionKind, sessionId).catch(() => {})
                );
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, config, reconnectNonce]);

    // 主题/强调色/皮肤/配色方案/联动切换时实时更新终端颜色
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        const colors = getTerminalTheme(
            theme,
            terminalColorLink ? accentColor : undefined,
            skin,
            undefined,
            terminalColorScheme,
            customTerminalColors,
        ).theme;
        term.options.theme = colors;
        term.refresh(0, term.rows - 1);
    }, [theme, accentColor, skin, terminalColorLink, terminalColorScheme, customTerminalColors]);

    // 外观热更新：改字号/字体/光标/行高/滚动缓冲后直接改 options 并重新 fit。
    // 不重建终端，因此不会丢失当前回滚缓冲与正在输出的内容。
    const appearanceInitRef = useRef(false);
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        // 首次渲染的 options 已由初始化 effect 用同一份 store 值构造，
        // 这里跳过首轮，避免挂载时多做一次 fit + Resize 往返。
        if (!appearanceInitRef.current) {
            appearanceInitRef.current = true;
            return;
        }
        term.options.fontSize = terminalFontSize;
        term.options.fontFamily = resolveTerminalFontFamily(terminalFontFamily);
        term.options.cursorStyle = terminalCursorStyle;
        term.options.cursorBlink = terminalCursorBlink;
        term.options.lineHeight = terminalLineHeight;
        term.options.scrollback = terminalScrollback;
        // 字号与行高会改变单元格尺寸，必须重新 fit 才能让后端 PTY 尺寸对齐；
        // 隐藏标签不参与布局，此时 fit 会把尺寸算成 0，故只在可见时执行。
        if (!isVisibleRef.current) return;
        try {
            fitAddonRef.current?.fit();
        } catch {
            return;
        }
        if (isReadyRef.current) {
            resizeSession(sessionId, term.rows, term.cols, sessionKind).catch(() => {});
        }
    }, [
        terminalFontSize,
        terminalFontFamily,
        terminalCursorStyle,
        terminalCursorBlink,
        terminalLineHeight,
        terminalScrollback,
        sessionId,
    ]);

    // 标签重新可见时重新 fit
    // 隐藏期间容器尺寸或字号可能已经变化（ResizeObserver 对 visibility 切换不触发），
    // 若不重新 fit，切回来会出现列数错位、右侧留白或内容被裁切。
    useEffect(() => {
        if (!isVisible) return;
        const container = containerRef.current;
        if (!container) return;
        const timer = setTimeout(() => {
            const term = terminalRef.current;
            if (!term || !fitAddonRef.current) return;
            if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
            try {
                fitAddonRef.current.fit();
            } catch {
                return;
            }
            if (isReadyRef.current && isVisibleRef.current) {
                resizeSession(sessionId, term.rows, term.cols, sessionKind).catch(() => {});
            }
        }, 0);
        return () => clearTimeout(timer);
    }, [isVisible, sessionId]);

    // SSH 数据事件 — 使用流控写入器 + 滚动锚定
    useEffect(() => {
        // 普通输出写入：解析 OSC 7 目录、命令结束标记与关键词高亮后交给流控写入器。
        // ZMODEM 会话期间协议字节会被桥接器拦下，只有非协议数据走到这里。
        const writeOutput = (rawBytes: Uint8Array) => {
            if (!terminalRef.current || !flowWriterRef.current) return;

            // 始终解析 shell 上报的 cwd：SFTP 面板按跟随开关决定是否导航，
            // 拖拽上传则依赖它定位目标目录。若仅在开启跟随时解析，关闭跟随
            // 后拖拽上传会错误地落到用户主目录而不是当前目录。
            osc7ParserRef.current?.(rawBytes);

            // 通知 / 命令结束标记：旁路解析，不影响终端显示
            signalParserRef.current?.(rawBytes);

            // 非激活标签收到输出时点亮活动指示点（store 内部会去重）
            if (useSessionStore.getState().activeSessionId !== sessionId) {
                useSessionStore.getState().markSessionActivity(sessionId);
            }

            // 关键词高亮：在事件回调中实时读取 store 设置（非渲染上下文）
            // 开启时将原始字节解码为文本、高亮关键词后以字符串写入终端
            // 关闭时直接写入原始字节（保持原有行为，性能最优）
            const highlightEnabled = useUIStore.getState().keywordHighlight;
            const decoder = decoderRef.current;
            let writeData: Uint8Array | string = rawBytes;
            if (decoder) {
                // 遗留编码：按流式解码为文本再写入。关键词高亮内部按 UTF-8
                // 处理字节，在该模式下跳过，避免二次解码破坏内容。
                writeData = decoder.decode(rawBytes, {stream: true});
            } else if (highlightEnabled && keywordHighlighterRef.current) {
                writeData = keywordHighlighterRef.current.process(rawBytes);
            }

            flowWriterRef.current?.write(writeData).then(() => {
                if (scrollAnchorRef.current?.shouldScrollToBottom()) {
                    scrollAnchorRef.current.forceScrollToBottom();
                }
            }).catch(() => {});
        };

        writeOutputRef.current = writeOutput;

        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            const data = event?.data as { id?: string; data?: string } | null;
            if (!data || data.id !== sessionId) return;
            try {
                const rawBytes = decodeBase64ToUint8Array(data.data || "");
                const bridge = zmodemBridgeRef.current;
                if (bridge) {
                    // Sentry 检测到 ZMODEM 头后接管字节流，其余数据交给 writeOutput
                    bridge.consume(rawBytes);
                } else {
                    writeOutput(rawBytes);
                }
            } catch {
                // base64 解码失败时忽略该数据包
            }
        });

        // SSH 关闭事件 — 标记会话断开，立即关闭输入通道避免断开瞬间输入产生错误
        const unsubscribeClosed = Events.On(AppEvent.SshClosed, (event) => {
            const data = event?.data as { id?: string } | null;
            if (data?.id === sessionId) {
                // 重连时旧会话的 Disconnect 也会触发一次 closed；此时新连接
                // 尚未就绪，忽略该事件，避免把刚建立的新会话改回断开状态。
                if (!isReadyRef.current && !hasConnectedRef.current) return;
                isReadyRef.current = false;
                setSessionStatus(sessionId, "disconnected");
                // 刷新解码器中残留的字节，避免丢失最后一小段输出：
                // 关键词高亮按 UTF-8 暂存，流式 TextDecoder 也可能停在半个多字节字符上
                if (keywordHighlighterRef.current && terminalRef.current) {
                    const flushed = keywordHighlighterRef.current.flush();
                    if (flushed) {
                        terminalRef.current.write(flushed);
                    }
                }
                const decoder = decoderRef.current;
                if (decoder && terminalRef.current) {
                    try {
                        const tail = decoder.decode();
                        if (tail) terminalRef.current.write(tail);
                    } catch {
                        // 解码器已失效时忽略：会话已经断开，不能影响断开提示
                    }
                }
            }
        });

        return () => {
            unsubscribe();
            unsubscribeClosed();
        };
    }, [sessionId, setSessionStatus]);

    // 当文件面板显示/隐藏时，等布局稳定后强制 fit + refresh
    useEffect(() => {
        if (!isFocused || !isReadyRef.current) return;
        const timer = setTimeout(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            try {
                fitAddonRef.current.fit();
                resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols, sessionKind).catch(() => {});
                terminalRef.current.refresh(0, terminalRef.current.rows - 1);
            } catch {
                // 忽略
            }
        }, 120);
        return () => clearTimeout(timer);
    }, [isFilePanelVisible, isFocused, sessionId]);

    // 会话断开时在终端显示提示，并阻止继续输入
    // 注意：SshClosed 事件处理器会先把 isReadyRef 置为 false，若此处仍以
    // isReadyRef 作为判据，提示将永远不会输出。改用 hasConnectedRef 判断本会话
    // 是否成功连接过（连接失败时不会误报），并用 disconnectNotifiedRef 保证只打印一次。
    useEffect(() => {
        if (!disconnected) {
            disconnectNotifiedRef.current = false;
            return;
        }
        isReadyRef.current = false;
        setSessionStatus(sessionId, "disconnected");
        if (hasConnectedRef.current && !disconnectNotifiedRef.current && terminalRef.current) {
            disconnectNotifiedRef.current = true;
            terminalRef.current.write(`\r\n\x1b[33m${t("session_disconnected")}\x1b[0m\r\n`);
        }

        // 自动重连：仅在用户成功连接过且开启了自动重连时尝试，
        // 最多 3 次（2s / 5s / 10s）。手动关闭标签会卸载组件并清掉定时器。
        // 本地终端 shell 退出属于用户主动行为，不自动拉起新 shell。
        // 重连期间 init effect 的 cleanup 会把 hasConnectedRef 置回 false，
        // 仅凭它判断会让自动重连只尝试一次。reconnectAttemptsRef > 0 表示本轮
        // 重连尚未成功，据此继续 2s/5s/10s 的后续尝试。
        const reconnecting = reconnectAttemptsRef.current > 0;
        // 浮动窗口是独立 webview，它的 store 里没有该会话（会话由主窗口管理）。
        // reconnectSession 会遍历空数组，打印"正在重连"却永远不发连接请求；
        // 浮动窗口改用手动重连按钮（递增 reconnectNonce）触发重连。
        const managedByStore = useSessionStore.getState().sessions.some((s) => s.id === sessionId);
        if (!isLocal && managedByStore && useUIStore.getState().autoReconnect && (hasConnectedRef.current || reconnecting)) {
            const attempt = reconnectAttemptsRef.current;
            if (attempt < 3) {
                const delay = [2000, 5000, 10000][attempt];
                reconnectAttemptsRef.current = attempt + 1;
                if (terminalRef.current) {
                    terminalRef.current.write(`\x1b[33m${t("reconnect_attempt", { attempt: attempt + 1, delay: Math.round(delay / 1000) })}\x1b[0m\r\n`);
                }
                autoReconnectTimerRef.current = setTimeout(() => {
                    autoReconnectTimerRef.current = null;
                    useSessionStore.getState().reconnectSession(sessionId);
                }, delay);
            }
        }

        return () => {
            if (autoReconnectTimerRef.current) {
                clearTimeout(autoReconnectTimerRef.current);
                autoReconnectTimerRef.current = null;
            }
        };
    }, [disconnected, t, sessionId, setSessionStatus]);

    // 关闭补全开关时立即收起建议面板，避免残留列表
    useEffect(() => {
        if (commandSuggestions) return;
        inputLineRef.current = "";
        lineTrustedRef.current = false;
        suggestionsRef.current = [];
        setSuggestions([]);
        setGhost(null);
    }, [commandSuggestions]);

    // 会话断开后不再展示补全建议（输入已不可用）
    useEffect(() => {
        if (!disconnected) return;
        inputLineRef.current = "";
        lineTrustedRef.current = false;
        suggestionsRef.current = [];
        setSuggestions([]);
        setGhost(null);
    }, [disconnected]);

    // 把选中文本加入自定义高亮规则：只取第一行，避免多行选择产生无效规则
    const highlightSelection = () => {
        const term = terminalRef.current;
        if (!term) return;
        const selection = term.getSelection();
        if (!selection) return;
        const pattern = selection.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 100);
        if (!pattern) return;

        const state = useUIStore.getState();
        if (state.highlightRules.some((r) => !r.regex && r.pattern === pattern)) {
            toast.info(t("highlight_exists"));
            return;
        }
        state.addHighlightRule({pattern, regex: false, color: "yellow", enabled: true});
        // 规则只有在关键词高亮开启时才生效，用户点击高亮即视为希望启用
        if (!state.keywordHighlight) state.setKeywordHighlight(true);
        toast.success(t("highlight_added", {pattern}));
    };

    // 拖拽本地文件到终端：SSH 会话上传到当前目录并插入远端路径；
    // 本地终端直接把本地路径插入命令行。外部文件路径由后端事件转交
    // （WebView2 不允许网页读取 DataTransfer 里的绝对路径）。
    const handleFileDragOver = (e: React.DragEvent) => {
        if (!isReadyRef.current) return;
        const types = Array.from(e.dataTransfer.types).map((type) => type.toLowerCase());
        // 本地终端接受系统文件并插入路径；SSH 接受上传与 SFTP 面板拖出的远端路径。
        // Telnet / 串口没有 SFTP，也不适合把本地路径直接灌进对端终端。
        const accepts = ((isLocal || isSsh) && types.includes("files"))
            || (isSsh && types.includes(REMOTE_PATH_MIME));
        if (!accepts) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!isDragOver) setIsDragOver(true);
    };

    const handleFileDragLeave = (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragOver(false);
        }
    };

    // 内部拖拽（SFTP 文件行 → 终端）：插入远端路径，不做上传
    const handleFileDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        if (!isReadyRef.current || !isSsh) return;
        const remotePath = e.dataTransfer.getData(REMOTE_PATH_MIME);
        if (remotePath) {
            sendSessionInput(sessionId, shellQuote(remotePath) + " ", sessionKind).catch(printErrorToTerminal);
        }
    };

    const handleDroppedFiles = async (paths: string[]) => {
        if (!isReadyRef.current || paths.length === 0) return;

        // 本地终端：直接把路径插入命令行，由用户决定执行什么命令
        if (isLocal) {
            sendSessionInput(sessionId, paths.map((p) => quoteLocalPath(p, localShellRef.current)).join(" ") + " ", sessionKind)
                .catch(printErrorToTerminal);
            return;
        }
        // Telnet / 串口没有 SFTP，无法把本地文件送到对端
        if (!isSsh) return;

        const state = useSessionStore.getState();
        const session = state.sessions.find((s) => s.id === sessionId);
        if (session?.status !== "connected") return;

        // 优先使用 shell 上报的 cwd；尚未上报时回退到用户主目录
        let dir = session.cwd;
        if (!dir) {
            try {
                dir = await SftpService.HomeDir(sessionId);
            } catch (err) {
                handleAppError(err);
                return;
            }
        }
        const baseDir = dir || "/";

        const results = await Promise.allSettled(paths.map((localPath) => {
            const name = localBasename(localPath);
            const remotePath = joinRemotePath(baseDir, name);
            const transferId = crypto.randomUUID();
            addTransfer({
                id: transferId,
                sessionId,
                filename: name,
                type: "upload",
                transferred: 0,
                total: 0,
                status: "queued",
                // 保留路径，队列里的暂停/续传与失败重试都需要
                localPath,
                remotePath,
            });
            // 与 SFTP 面板共用调度器：拖入多个文件时按并发上限排队，
            // 全部完成后才能把远端路径插入命令行。
            return new Promise<string>((resolve, reject) => {
                scheduleTransfer(sessionId, transferId, async () => {
                    updateTransfer(transferId, { status: "active" });
                    try {
                        // Upload 自动区分文件与目录：拖入文件夹时递归上传其全部内容
                        await SftpService.Upload(sessionId, transferId, localPath, remotePath);
                        updateTransfer(transferId, { status: "success" });
                        resolve(remotePath);
                    } catch (err) {
                        // 用户主动取消：队列显示"已取消"，不按失败计
                        updateTransfer(transferId, isTransferCanceled(err)
                            ? { status: "error", cancelled: true }
                            : { status: "error", error: String((err as Error)?.message ?? err) });
                        reject(err);
                    }
                }, () => reject(new Error("传输已取消")));
            });
        }));

        const uploaded: string[] = [];
        let failedCount = 0;
        for (const result of results) {
            if (result.status === "fulfilled") {
                uploaded.push(result.value);
            } else if (!isTransferCanceled(result.reason)) {
                failedCount++;
            }
        }

        if (uploaded.length > 0) {
            sendSessionInput(sessionId, uploaded.map(shellQuote).join(" ") + " ", sessionKind)
                .catch(printErrorToTerminal);
            toast.success(t("upload_drop_success", {count: uploaded.length}));
        }
        if (failedCount > 0) {
            toast.error(t("upload_drop_failed", {count: failedCount}));
        }
    };

    // 后端转发的系统文件拖放事件：只处理落在本窗格上的文件
    const droppedFilesHandlerRef = useRef(handleDroppedFiles);
    droppedFilesHandlerRef.current = handleDroppedFiles;
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.FileDrop, (event) => {
            const payload = event?.data as
                | { files?: string[]; sessionId?: string; kind?: string }
                | null;
            if (!payload || payload.sessionId !== sessionId || payload.kind !== "terminal") return;
            if (!payload.files || payload.files.length === 0) return;
            void droppedFilesHandlerRef.current(payload.files);
        });
        return () => unsubscribe();
    }, [sessionId]);

    // 搜索功能
    const handleSearch = (direction: "next" | "prev") => {
        const addon = searchAddonRef.current;
        if (!addon) return;
        if (!searchQuery) {
            addon.clearDecorations();
            setSearchResults({ index: -1, count: 0 });
            return;
        }
        if (direction === "next") {
            addon.findNext(searchQuery, SEARCH_OPTIONS);
        } else {
            addon.findPrevious(searchQuery, SEARCH_OPTIONS);
        }
    };

    /** 关闭搜索面板：清掉高亮 decorations 与命中计数，避免残留黄色色块 */
    const closeSearch = () => {
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults({ index: -1, count: 0 });
        searchAddonRef.current?.clearDecorations();
    };

    // 输入即搜（增量搜索）：输入停顿 120ms 后再执行，避免长回滚缓冲区下每敲
    // 一个字都全量扫描导致输入卡顿。
    useEffect(() => {
        if (!showSearch) return;
        const addon = searchAddonRef.current;
        if (!addon) return;
        if (!searchQuery) {
            addon.clearDecorations();
            setSearchResults({ index: -1, count: 0 });
            return;
        }
        const timer = setTimeout(() => {
            addon.findNext(searchQuery, SEARCH_OPTIONS);
        }, 120);
        return () => clearTimeout(timer);
    }, [searchQuery, showSearch]);

    // 划词搜索：取选中的第一行作为查询词，避免多行内容拼成无效搜索
    const handleSelectionSearch = (engine: "bing" | "github") => {
        const query = selectionText.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200);
        if (!query) return;
        if (engine === "bing") searchBing(query);
        else searchGitHub(query);
    };

    const selectedUrl = /^https?:\/\/\S+$/i.test(selectionText) ? selectionText : "";
    const handleOpenSelectedUrl = () => {
        if (selectedUrl) openExternalUrl(selectedUrl);
    };

    return (
        <div
            data-file-drop-target
            data-session-id={sessionId}
            data-drop-kind="terminal"
            onMouseDown={() => {
                // 分屏时两个窗格同时可见，点击未聚焦的窗格即切换焦点
                if (!isFocused) {
                    useSessionStore.getState().setActiveSession(sessionId);
                }
            }}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            className={cn(
                "terminal-pane absolute bg-[var(--surface-0)] p-[var(--terminal-padding)]",
                className ?? "inset-0",
                isVisible ? "" : "pointer-events-none",
                isFocused ? "terminal-pane-focused z-10" : "terminal-pane-unfocused"
            )}
            style={{
                ...style,
                visibility: isVisible ? "visible" : "hidden",
            }}
        >
            <div ref={containerRef} className="h-full w-full"/>

            {/* 行内 ghost 建议：贴在光标右侧显示首条建议的剩余内容 */}
            {isFocused && ghost && !isDragOver && (
                <div
                    aria-hidden
                    className="pointer-events-none absolute z-[5] overflow-hidden whitespace-pre opacity-50"
                    style={{
                        left: ghost.left,
                        top: ghost.top,
                        height: ghost.height,
                        lineHeight: `${ghost.height}px`,
                        maxWidth: ghost.maxWidth,
                        fontSize: terminalFontSize,
                        fontFamily: resolveTerminalFontFamily(terminalFontFamily),
                        color: "var(--fg-muted)",
                    }}
                >
                    {ghost.text}
                </div>
            )}

            {/* 命令行补全建议：历史整行前缀 + 常用命令首词，Tab / → / 单击接受 */}
            {isFocused && suggestions.length > 0 && !isDragOver && (
                <div
                    className="absolute left-3 z-20 w-[min(520px,calc(100%-24px))] overflow-hidden
                               rounded-[var(--radius-md)] border border-[var(--hairline)]
                               bg-[var(--surface-1)] shadow-[var(--shadow-menu)]"
                    style={{bottom: "calc(var(--terminal-padding) + 1.9rem)"}}
                >
                    {suggestions.map((item) => (
                        <button
                            key={item.text}
                            type="button"
                            onMouseDown={(e) => {
                                // 阻止默认行为以保持终端焦点，再接受该条建议
                                e.preventDefault();
                                acceptCommandSuggestion(item);
                            }}
                            className="flex w-full items-center gap-2 px-2.5 py-1 text-left font-mono
                                       text-[11.5px] text-[var(--fg-muted)] transition-colors
                                       hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                        >
                            <span className="min-w-0 flex-1 truncate">{item.text}</span>
                            <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">
                                {item.source === "history"
                                    ? t("suggest_source_history")
                                    : t("suggest_source_builtin")}
                            </span>
                        </button>
                    ))}
                    <div className="border-t border-[var(--hairline)] px-2.5 py-1 text-[10px] text-[var(--fg-subtle)]">
                        {t("suggest_hint")}
                    </div>
                </div>
            )}

            {/* 拖拽提示层：SSH 会话上传文件，本地终端插入路径 */}
            {isDragOver && (
                <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center
                                rounded-[var(--radius-md)] border-2 border-dashed border-primary
                                bg-[var(--surface-0)] text-xs text-[var(--fg-strong)]">
                    {isLocal ? t("drop_insert_path_hint") : t("upload_drop_hint")}
                </div>
            )}

            {/* 划词操作：打开链接 / Bing / GitHub / 高亮 */}
            {isFocused && !showSearch && hasSelection && (
                <div
                    onMouseDown={(e) => e.preventDefault()}
                    className="terminal-overlay-btn absolute right-3 top-12 z-20 flex items-center gap-0.5 p-0.5"
                >
                    {selectedUrl && (
                        <button
                            type="button"
                            onClick={handleOpenSelectedUrl}
                            title={t("open_link")}
                            className="flex size-6 items-center justify-center rounded-[var(--radius-sm)]
                                       text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                        >
                            <ExternalLink className="size-3.5"/>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => handleSelectionSearch("bing")}
                        title={t("search_bing")}
                        className="flex size-6 items-center justify-center rounded-[var(--radius-sm)]
                                   text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                    >
                        <Globe className="size-3.5"/>
                    </button>
                    <button
                        type="button"
                        onClick={() => handleSelectionSearch("github")}
                        title={t("search_github")}
                        className="flex size-6 items-center justify-center rounded-[var(--radius-sm)]
                                   text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                    >
                        <GitBranch className="size-3.5"/>
                    </button>
                </div>
            )}

            {/* 划词高亮：选中文本后一键加入自定义高亮规则 */}
            {isFocused && !showSearch && hasSelection && (
                <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={highlightSelection}
                    title={t("highlight_selection")}
                    className="terminal-overlay-btn absolute right-11 top-3 z-20 size-7"
                >
                    <Highlighter className="size-3.5"/>
                </button>
            )}

            {/* 搜索按钮（搜索面板未打开时显示在右上角） */}
            {isFocused && !showSearch && (
                <button
                    onClick={() => {
                        setShowSearch(true);
                        setTimeout(() => searchInputRef.current?.focus(), 50);
                    }}
                    title={t("search_open")}
                    className="terminal-overlay-btn absolute right-3 top-3 z-20 size-7"
                >
                    <Search className="size-3.5"/>
                </button>
            )}

            {/* 终端搜索面板（借鉴 Tabby） */}
            {showSearch && isFocused && (
                <div className="terminal-search-panel absolute right-3 top-3 z-20">
                    <input
                        ref={searchInputRef}
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                handleSearch(e.shiftKey ? "prev" : "next");
                            } else if (e.key === "Escape") {
                                closeSearch();
                            }
                        }}
                        placeholder={t("search_placeholder")}
                        className="terminal-search-input"
                    />
                    {/* 命中计数：n/m；无匹配时显示 0/0 并弱化颜色 */}
                    {searchQuery && (
                        <span
                            className={cn(
                                "min-w-9 text-center text-[10.5px] leading-none tabular-nums",
                                searchResults.count === 0
                                    ? "text-[var(--destructive)]"
                                    : "text-[var(--fg-subtle)]",
                            )}
                            title={t("search_results", {
                                index: searchResults.index + 1,
                                total: searchResults.count,
                            })}
                        >
                            {searchResults.count === 0
                                ? "0/0"
                                : `${searchResults.index + 1}/${searchResults.count}`}
                        </span>
                    )}
                    <button
                        onClick={() => handleSearch("prev")}
                        className="terminal-search-btn"
                        title={t("search_prev")}
                    >
                        <ChevronUp className="size-3.5"/>
                    </button>
                    <button
                        onClick={() => handleSearch("next")}
                        className="terminal-search-btn"
                        title={t("search_next")}
                    >
                        <ChevronDown className="size-3.5"/>
                    </button>
                    <button
                        onClick={closeSearch}
                        className="terminal-search-btn"
                        title={t("search_close")}
                    >
                        <X className="size-3.5"/>
                    </button>
                </div>
            )}

            {/* 断线后的手动重连入口 */}
            {disconnected && (
                <div className="absolute inset-x-0 top-1/2 z-30 flex -translate-y-1/2 justify-center">
                    <button
                        type="button"
                        onClick={() => {
                            reconnectAttemptsRef.current = 0;
                            useSessionStore.getState().reconnectSession(sessionId);
                        }}
                        className="terminal-overlay-btn px-3 py-1.5 text-xs"
                    >
                        <RotateCw className="size-3.5"/>
                        {t("reconnect")}
                    </button>
                </div>
            )}

            {/* 终端右键菜单 */}
            <TerminalContextMenu
                open={contextMenu !== null}
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                hasSelection={hasSelection}
                onClose={closeContextMenu}
                onCopy={copySelection}
                onPaste={pasteFromClipboard}
                onSelectAll={() => terminalRef.current?.selectAll()}
                onFind={openSearchPanel}
                onSaveBuffer={saveTerminalBuffer}
                onOpenCompose={openComposePanel}
                onZmodemUpload={supportsZmodem ? handleZmodemUpload : undefined}
            />

            {/* 多行粘贴确认 */}
            <ConfirmModal
                isOpen={!!pendingPaste}
                onClose={() => setPendingPaste(null)}
                onConfirm={() => {
                    if (pendingPaste && terminalRef.current && isReadyRef.current) {
                        terminalRef.current.paste(pendingPaste);
                    }
                    setPendingPaste(null);
                }}
                title={t("paste_warning_title")}
                description={t("paste_warning_desc", {
                    count: pendingPaste ? pendingPaste.split(/\r?\n/).filter((line) => line.length > 0).length : 0,
                    preview: pendingPaste ? pendingPaste.split(/\r?\n/).find((line) => line.length > 0)?.slice(0, 80) : "",
                })}
                confirmText={t("paste_confirm")}
            />
        </div>
    );
}
