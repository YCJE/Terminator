import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Events, Clipboard } from "@wailsio/runtime";
import { getTerminalTheme } from "@/lib/terminalTheme";
import { parseAppError, handleAppError } from "@/lib/error";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
import { createFlowControlledWriter, setupScrollAnchoring } from "@/lib/terminalFlowControl";
import { createKeywordHighlighter, DEFAULT_KEYWORDS } from "@/lib/keywordHighlight";
import { createOsc7Parser } from "@/lib/osc7";
import { createTerminalSignalParser } from "@/lib/terminalSignals";
import { joinRemotePath, localBasename, quoteLocalPath, shellQuote, REMOTE_PATH_MIME } from "@/lib/remotePath";
import { sendSessionInput, resizeSession } from "@/lib/sessionTransport";
import { openExternalUrl, searchBing, searchGitHub } from "@/lib/openExternal";
import { showDesktopNotification } from "@/lib/desktopNotify";
import { matchesCombo } from "@/lib/shortcuts";
import "@xterm/xterm/css/xterm.css";
import { SSHConnectionConfig, SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import { LocalShellService } from "../../../bindings/terminator-desktop/backend/internal/services/local";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { useSessionStore, type SessionKind } from "@/store/sessionStore.ts";
import { useTransferStore } from "@/store/transferStore";
import { ConfirmModal } from "@/components/ui/confirm-modal";
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
    disconnected?: boolean;
    /** 连接成功后自动执行的命令 */
    onConnect?: string;
    /** 定位类名：普通标签为 inset-0，分屏窗格各占半幅 */
    className?: string;
    /** 分屏比例定位（覆盖 inset-0 的对应边） */
    style?: CSSProperties;
    /** 重连计数：变化时重新建立 SSH 连接并回放最近输出 */
    reconnectNonce?: number;
}

export function TerminalInstance({sessionId, isVisible, isFocused, config, sessionKind, disconnected, onConnect, className, style, reconnectNonce}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
    const isLocal = sessionKind === "local";
    const theme = useUIStore((s) => s.theme);
    const accentColor = useUIStore((s) => s.accentColor);
    const skin = useUIStore((s) => s.skin);
    const terminalColorLink = useUIStore((s) => s.terminalColorLink);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
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

    // 多行粘贴确认
    const [pendingPaste, setPendingPaste] = useState<string | null>(null);
    // 终端是否有选中文本（用于"高亮所选"与划词搜索快捷操作）
    const [hasSelection, setHasSelection] = useState(false);
    const [selectionText, setSelectionText] = useState("");
    // 文件拖拽上传状态
    const [isDragOver, setIsDragOver] = useState(false);
    const addTransfer = useTransferStore((s) => s.addTransfer);
    const updateTransfer = useTransferStore((s) => s.updateTransfer);

    // 搜索面板状态
    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const searchInputRef = useRef<HTMLInputElement>(null);
    // 用 ref 跟踪 showSearch 最新值，供 attachCustomKeyEventHandler 闭包使用
    const showSearchRef = useRef(showSearch);
    showSearchRef.current = showSearch;

    const printErrorToTerminal = (error: unknown) => {
        if (!terminalRef.current) return;
        const appError = parseAppError(error);
        const translated = t("error_message", { message: appError.message, error: appError.detailsString })
        terminalRef.current.write(`\r\n\x1b[31m${translated}\x1b[0m\r\n`)
    };

    // 粘贴入口：多行内容在开启保护时先弹确认，避免把整段脚本误灌进生产环境
    const pasteIntoTerminal = (text: string) => {
        if (!text || !terminalRef.current || !isReadyRef.current) return;
        const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
        if (useUIStore.getState().pasteProtection && lines.length > 1) {
            setPendingPaste(text);
            return;
        }
        terminalRef.current.paste(text);
    };

    // 终端初始化（sessionId/config 变化或重连时重新执行）
    useEffect(() => {
        if (!containerRef.current || terminalRef.current) return;
        const container = containerRef.current;

        let cancelled = false;

        const term = new Terminal(getTerminalTheme(theme, terminalColorLink ? accentColor : undefined, skin));
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

        // 初始化流控写入器和滚动锚定
        flowWriterRef.current = createFlowControlledWriter(term);
        scrollAnchorRef.current = setupScrollAnchoring(term, container);
        // 初始化关键词高亮处理器（内部维护 TextDecoder stream 状态）。
        // 自定义规则通过 getter 实时读取，修改规则后无需重建终端。
        keywordHighlighterRef.current = createKeywordHighlighter(
            DEFAULT_KEYWORDS,
            () => useUIStore.getState().highlightRules,
        );
        // 选中文本时显示"高亮所选"与划词搜索快捷操作
        const selectionDisposable = term.onSelectionChange(() => {
            const selection = term.getSelection().trim();
            // 仅空白选区不显示操作浮层：此时没有可搜索/可高亮的内容
            setHasSelection(!!selection);
            setSelectionText(selection.slice(0, 2048));
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
                    return false;
                }
            }
            return true;
        });

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            const selection = term.getSelection();
            if (selection) {
                Clipboard.SetText(selection).catch(console.error);
                term.clearSelection();
            } else {
                Clipboard.Text().then((text) => {
                    if (text) pasteIntoTerminal(text);
                }).catch(console.error);
            }
        };
        container.addEventListener("contextmenu", handleContextMenu);

        // 连接成功后自动执行主机配置的初始化命令。延迟一小段等远端 shell
        // 提示符就绪，避免命令与登录横幅的输出交叠或被丢弃。
        let onConnectTimer: ReturnType<typeof setTimeout> | null = null;

        if (!hasConnectedRef.current) {
            setSessionStatus(sessionId, "connecting");
            // Connect 排在上一次 Disconnect 之后执行；组件卸载/重连时再把新的
            // Disconnect 追加到链尾，保证"先断旧、再连新、必要时再断"的顺序。
            const connectTask = connectChainRef.current.then(() =>
                cancelled
                    ? undefined
                    : (isLocal ? LocalShellService.Start(sessionId, "") : SshService.Connect(config))
            );
            connectChainRef.current = connectTask.catch(() => {});
            connectTask
                .then(() => {
                    if (cancelled) return;
                    isReadyRef.current = true;
                    hasConnectedRef.current = true;
                    reconnectAttemptsRef.current = 0;
                    setSessionStatus(sessionId, "connected");
                    if (terminalRef.current && fitAddonRef.current) {
                        fitAddonRef.current.fit();
                        resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                            .catch(console.error);
                    }
                    const command = onConnect?.trim();
                    if (command) {
                        onConnectTimer = setTimeout(() => {
                            if (cancelled || !isReadyRef.current) return;
                            sendSessionInput(sessionId, command.replace(/\r\n/g, "\n") + "\n")
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
            sendSessionInput(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
            // 广播模式：同时发送到其他所有活跃终端
            const {broadcastMode, getActiveSessionIds} = useSessionStore.getState();
            if (broadcastMode) {
                const others = getActiveSessionIds().filter((id) => id !== sessionId);
                for (const id of others) {
                    sendSessionInput(id, data).catch(() => {});
                }
            }
        });

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
                    resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                        .catch(() => {});
                }
            }, 150);
        });
        resizeObserver.observe(container);

        return () => {
            cancelled = true;
            if (onConnectTimer) clearTimeout(onConnectTimer);
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
            container.removeEventListener("contextmenu", handleContextMenu);
            onDataDisposable.dispose();
            selectionDisposable.dispose();
            setHasSelection(false);
            setSelectionText("");
            // 重连前保存尾部输出：serialize 会包含全部 scrollback，
            // 这里截取末尾一段，既保留上下文又避免长会话占用过多内存。
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
            connectChainRef.current = connectChainRef.current.then(() =>
                (isLocal
                    ? LocalShellService.Close(sessionId)
                    : SshService.Disconnect(sessionId)).catch(() => {})
            );
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, config, reconnectNonce]);

    // 主题/强调色/皮肤/联动切换时实时更新终端颜色
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        const colors = getTerminalTheme(theme, terminalColorLink ? accentColor : undefined, skin).theme;
        term.options.theme = colors;
        term.refresh(0, term.rows - 1);
    }, [theme, accentColor, skin, terminalColorLink]);

    // SSH 数据事件 — 使用流控写入器 + 滚动锚定
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            const data = event?.data as { id?: string; data?: string } | null;
            if (!data || data.id !== sessionId || !terminalRef.current || !flowWriterRef.current) return;
            try {
                const rawBytes = decodeBase64ToUint8Array(data.data || "");

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
                const writeData = highlightEnabled && keywordHighlighterRef.current
                    ? keywordHighlighterRef.current.process(rawBytes)
                    : rawBytes;

                flowWriterRef.current.write(writeData).then(() => {
                    if (scrollAnchorRef.current?.shouldScrollToBottom()) {
                        scrollAnchorRef.current.forceScrollToBottom();
                    }
                }).catch(() => {});
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
                // 刷新关键词高亮解码器中残留的字节，避免丢失最后一小段输出
                if (keywordHighlighterRef.current && terminalRef.current) {
                    const flushed = keywordHighlighterRef.current.flush();
                    if (flushed) {
                        terminalRef.current.write(flushed);
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
                resizeSession(sessionId, terminalRef.current.rows, terminalRef.current.cols).catch(() => {});
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
        if (!isLocal && useUIStore.getState().autoReconnect && hasConnectedRef.current) {
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
        // 本地终端只接受系统文件；远端路径 MIME 来自 SFTP 面板，插入本地 shell 没有意义
        const accepts = types.includes("files") || (!isLocal && types.includes(REMOTE_PATH_MIME));
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
        if (!isReadyRef.current || isLocal) return;
        const remotePath = e.dataTransfer.getData(REMOTE_PATH_MIME);
        if (remotePath) {
            sendSessionInput(sessionId, shellQuote(remotePath) + " ").catch(printErrorToTerminal);
        }
    };

    const handleDroppedFiles = async (paths: string[]) => {
        if (!isReadyRef.current || paths.length === 0) return;

        // 本地终端：直接把路径插入命令行，由用户决定执行什么命令
        if (isLocal) {
            sendSessionInput(sessionId, paths.map(quoteLocalPath).join(" ") + " ")
                .catch(printErrorToTerminal);
            return;
        }

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

        const results = await Promise.allSettled(paths.map(async (localPath) => {
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
                status: "active",
            });
            try {
                await SftpService.UploadFile(sessionId, transferId, localPath, remotePath);
                updateTransfer(transferId, { status: "success" });
                return remotePath;
            } catch (err) {
                updateTransfer(transferId, {
                    status: "error",
                    error: String((err as Error)?.message ?? err),
                });
                throw err;
            }
        }));

        const uploaded: string[] = [];
        let failedCount = 0;
        for (const result of results) {
            if (result.status === "fulfilled") uploaded.push(result.value);
            else failedCount++;
        }

        if (uploaded.length > 0) {
            sendSessionInput(sessionId, uploaded.map(shellQuote).join(" ") + " ")
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
        if (!searchAddonRef.current || !searchQuery) return;
        if (direction === "next") {
            searchAddonRef.current.findNext(searchQuery);
        } else {
            searchAddonRef.current.findPrevious(searchQuery);
        }
    };

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
                                setShowSearch(false);
                            }
                        }}
                        placeholder={t("search_placeholder")}
                        className="terminal-search-input"
                    />
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
                        onClick={() => {
                            setShowSearch(false);
                            setSearchQuery("");
                        }}
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
