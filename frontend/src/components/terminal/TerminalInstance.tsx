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
import "@xterm/xterm/css/xterm.css";
import { SSHConnectionConfig, SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { X, ChevronUp, ChevronDown } from "lucide-react";

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

        const term = new Terminal(getTerminalTheme(theme, terminalColorLink ? accentColor : undefined));
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
                    if (cancelled) return;
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
                });
        }

        const onDataDisposable = term.onData((data) => {
            if (!isReadyRef.current) return;
            SshService.Input(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
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
                } catch (e) {
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

    // 主题/强调色/联动切换时实时更新终端颜色
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        const colors = getTerminalTheme(theme, terminalColorLink ? accentColor : undefined).theme;
        term.options.theme = colors;
        term.refresh(0, term.rows - 1);
    }, [theme, accentColor, terminalColorLink]);

    // SSH 数据事件 — 使用流控写入器 + 滚动锚定
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            const data = event?.data as { id?: string; data?: string } | null;
            if (!data || data.id !== sessionId || !terminalRef.current || !flowWriterRef.current) return;
            try {
                const rawBytes = decodeBase64ToUint8Array(data.data || "");
                flowWriterRef.current.write(rawBytes).then(() => {
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
            } catch (e) {
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
                "terminal-pane absolute inset-0 bg-background p-2",
                isActive ? "terminal-pane-focused z-10" : "terminal-pane-unfocused pointer-events-none"
            )}
            style={{
                visibility: isActive ? "visible" : "hidden",
            }}
        >
            <div ref={containerRef} className="h-full w-full"/>

            {/* 终端搜索面板（借鉴 Tabby） */}
            {showSearch && isActive && (
                <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-md border border-border bg-popover p-1.5 shadow-lg">
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
                        placeholder={t("search_placeholder") || "搜索..."}
                        className="h-7 w-48 rounded-sm bg-background px-2 text-xs outline-none"
                    />
                    <button
                        onClick={() => handleSearch("prev")}
                        className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
                        title="上一个"
                    >
                        <ChevronUp className="size-3.5"/>
                    </button>
                    <button
                        onClick={() => handleSearch("next")}
                        className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
                        title="下一个"
                    >
                        <ChevronDown className="size-3.5"/>
                    </button>
                    <button
                        onClick={() => {
                            setShowSearch(false);
                            setSearchQuery("");
                        }}
                        className="flex size-6 items-center justify-center rounded-sm hover:bg-accent"
                        title="关闭"
                    >
                        <X className="size-3.5"/>
                    </button>
                </div>
            )}
        </div>
    );
}
