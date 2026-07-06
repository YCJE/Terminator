import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
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

interface TerminalInstanceProps {
    sessionId: string;
    isActive: boolean;
    config: SSHConnectionConfig;
    disconnected?: boolean;
}

export function TerminalInstance({sessionId, isActive, config, disconnected}: TerminalInstanceProps) {
    const {t} = useTranslation("terminal");
    const theme = useUIStore((s) => s.theme);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);

    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const serializeRef = useRef<SerializeAddon | null>(null);
    const flowWriterRef = useRef<ReturnType<typeof createFlowControlledWriter> | null>(null);
    const scrollAnchorRef = useRef<ReturnType<typeof setupScrollAnchoring> | null>(null);
    const hasConnectedRef = useRef(false);
    const isReadyRef = useRef(false);
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

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

        const term = new Terminal(getTerminalTheme(theme));
        const fitAddon = new FitAddon();
        const unicode11Addon = new Unicode11Addon();
        const serializeAddon = new SerializeAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(serializeAddon);
        term.unicode.activeVersion = "11";
        term.open(container);

        // 尝试加载 WebGL 渲染器，失败时回退到默认 canvas 渲染器
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
                // WebGL 上下文丢失后刷新终端，回退到 canvas 渲染
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

        // 初始化流控写入器和滚动锚定
        flowWriterRef.current = createFlowControlledWriter(term);
        scrollAnchorRef.current = setupScrollAnchoring(term, container);

        term.attachCustomKeyEventHandler((arg) => {
            if (arg.type === "keydown") {
                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyC") {
                    arg.preventDefault();
                    const selection = term.getSelection();
                    if (selection) {
                        Clipboard.SetText(selection).catch(console.error);
                    }
                    return false;
                }

                if (arg.ctrlKey && arg.shiftKey && arg.code === "KeyV") {
                    arg.preventDefault();
                    Clipboard.Text().then((text) => {
                        if (text && isReadyRef.current) {
                            term.paste(text);
                        }
                    }).catch(console.error);
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
            SshService.Connect(config)
                .then(() => {
                    if (cancelled) return;
                    isReadyRef.current = true;
                    hasConnectedRef.current = true;
                    if (terminalRef.current && fitAddonRef.current) {
                        fitAddonRef.current.fit();
                        SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                            .catch(console.error);
                    }
                })
                .catch((err) => {
                    if (cancelled) return;
                    printErrorToTerminal(err);
                });
        }

        const onDataDisposable = term.onData((data) => {
            if (!isReadyRef.current) return;
            SshService.Input(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
        });

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
            try {
                fitAddonRef.current.fit();
            } catch (e) {
                return;
            }
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
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
            // 重置流控状态，防止销毁后写入器仍持有待处理 Promise
            flowWriterRef.current?.reset();
            flowWriterRef.current = null;
            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            serializeRef.current = null;
            hasConnectedRef.current = false;
            isReadyRef.current = false;
            SshService.Disconnect(sessionId).catch(() => {});
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, config]);

    // 主题切换时实时更新终端颜色
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        const colors = getTerminalTheme(theme).theme;
        term.options.theme = colors;
        term.refresh(0, term.rows - 1);
    }, [theme]);

    // SSH 数据事件 — 使用流控写入器 + 滚动锚定
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            const data = event?.data as { id?: string; data?: string } | null;
            if (!data || data.id !== sessionId || !terminalRef.current || !flowWriterRef.current) return;
            try {
                const rawBytes = decodeBase64ToUint8Array(data.data || "");
                // 流控写入：高水位时自动背压，防止高速输出压垮渲染
                flowWriterRef.current.write(rawBytes).then(() => {
                    // 滚动锚定：仅在用户位于底部时自动滚动
                    if (scrollAnchorRef.current?.shouldScrollToBottom()) {
                        scrollAnchorRef.current.forceScrollToBottom();
                    }
                }).catch(() => {
                    // 终端可能已销毁，忽略写入错误
                });
            } catch {
                // base64 解码失败时忽略该数据包
            }
        });
        return () => unsubscribe();
    }, [sessionId]);

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
            terminalRef.current.write(`\r\n\x1b[33m${t("session_disconnected")}\x1b[0m\r\n`);
        }
    }, [disconnected, t]);

    return (
        <div className={cn("h-full w-full bg-background p-2", isActive ? "block" : "hidden")}>
            <div ref={containerRef} className="h-full w-full"/>
        </div>
    );
}
