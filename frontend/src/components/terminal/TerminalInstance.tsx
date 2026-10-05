import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { Events, Clipboard } from "@wailsio/runtime";
import { getTerminalTheme } from "@/lib/terminalTheme";
import { parseAppError } from "@/lib/error";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
import { createFlowControlledWriter, setupScrollAnchoring } from "@/lib/terminalFlowControl";
import { createKeywordHighlighter } from "@/lib/keywordHighlight";
import "@xterm/xterm/css/xterm.css";
import { SSHConnectionConfig, SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { X, ChevronUp, ChevronDown, Search } from "lucide-react";

interface TerminalInstanceProps {
    sessionId: string;
    isActive: boolean;
    config: SSHConnectionConfig;
    disconnected?: boolean;
}

export function TerminalInstance({sessionId, isActive, config, disconnected}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
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
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

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

    // 终端初始化（只在 sessionId/config 变化时重新执行）
    useEffect(() => {
        if (!containerRef.current || terminalRef.current) return;
        const container = containerRef.current;

        let cancelled = false;

        const term = new Terminal(getTerminalTheme(theme, terminalColorLink ? accentColor : undefined, skin));
        const fitAddon = new FitAddon();
        const unicode11Addon = new Unicode11Addon();
        const serializeAddon = new SerializeAddon();
        const searchAddon = new SearchAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(serializeAddon);
        term.loadAddon(searchAddon);
        term.unicode.activeVersion = "11";
        term.open(container);

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
        // 初始化关键词高亮处理器（内部维护 TextDecoder stream 状态）
        keywordHighlighterRef.current = createKeywordHighlighter();

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
                        if (text && isReadyRef.current) {
                            term.paste(text);
                        }
                    }).catch(console.error);
                    return false;
                }

                // Ctrl+F 打开搜索面板
                if (arg.ctrlKey && !arg.shiftKey && arg.code === "KeyF") {
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
                    if (text && isReadyRef.current) {
                        SshService.Input(sessionId, text).catch(printErrorToTerminal);
                    }
                }).catch(console.error);
            }
        };
        container.addEventListener("contextmenu", handleContextMenu);

        if (!hasConnectedRef.current) {
            setSessionStatus(sessionId, "connecting");
            SshService.Connect(config)
                .then(() => {
                    if (cancelled) {
                        // 组件在连接完成前已卸载：卸载时的 Disconnect 因后端尚未注册会话而空跑，
                        // 此时后端刚建立好的 SSH 会话会变成孤儿连接（占用连接池、日志句柄）。
                        // 必须补一次断开。
                        SshService.Disconnect(sessionId).catch(() => {});
                        return;
                    }
                    isReadyRef.current = true;
                    hasConnectedRef.current = true;
                    setSessionStatus(sessionId, "connected");
                    if (terminalRef.current && fitAddonRef.current) {
                        fitAddonRef.current.fit();
                        SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                            .catch(console.error);
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
            SshService.Input(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
            // 广播模式：同时发送到其他所有活跃终端
            const {broadcastMode, getActiveSessionIds} = useSessionStore.getState();
            if (broadcastMode) {
                const others = getActiveSessionIds().filter((id) => id !== sessionId);
                for (const id of others) {
                    SshService.Input(id, data).catch(() => {});
                }
            }
        });

        // 防抖 resize：fit() + SshService.Resize 一起延迟执行
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
                if (isActiveRef.current) {
                    SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                        .catch(() => {});
                }
            }, 150);
        });
        resizeObserver.observe(container);

        return () => {
            cancelled = true;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
            container.removeEventListener("contextmenu", handleContextMenu);
            onDataDisposable.dispose();
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
            setSessionStatus(sessionId, "disconnected");
            SshService.Disconnect(sessionId).catch(() => {});
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, config]);

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
        if (!isActive || !isReadyRef.current) return;
        const timer = setTimeout(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            try {
                fitAddonRef.current.fit();
                SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols).catch(() => {});
                terminalRef.current.refresh(0, terminalRef.current.rows - 1);
            } catch {
                // 忽略
            }
        }, 120);
        return () => clearTimeout(timer);
    }, [isFilePanelVisible, isActive, sessionId]);

    // 会话断开时在终端显示提示，并阻止继续输入
    useEffect(() => {
        if (disconnected && terminalRef.current && isReadyRef.current) {
            isReadyRef.current = false;
            setSessionStatus(sessionId, "disconnected");
            terminalRef.current.write(`\r\n\x1b[33m${t("session_disconnected")}\x1b[0m\r\n`);
        }
    }, [disconnected, t, sessionId, setSessionStatus]);

    // 搜索功能
    const handleSearch = (direction: "next" | "prev") => {
        if (!searchAddonRef.current || !searchQuery) return;
        if (direction === "next") {
            searchAddonRef.current.findNext(searchQuery);
        } else {
            searchAddonRef.current.findPrevious(searchQuery);
        }
    };

    return (
        <div
            className={cn(
                "terminal-pane absolute inset-0 bg-[var(--surface-0)] p-[var(--terminal-padding)]",
                isActive ? "terminal-pane-focused z-10" : "terminal-pane-unfocused pointer-events-none"
            )}
            style={{
                visibility: isActive ? "visible" : "hidden",
            }}
        >
            <div ref={containerRef} className="h-full w-full"/>

            {/* 搜索按钮（搜索面板未打开时显示在右上角） */}
            {isActive && !showSearch && (
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
            {showSearch && isActive && (
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
        </div>
    );
}
