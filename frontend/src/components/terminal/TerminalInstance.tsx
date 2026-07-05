import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Events, Clipboard } from "@wailsio/runtime";
import { getTerminalTheme } from "@/lib/terminalTheme";
import { parseAppError } from "@/lib/error";
import { cn, decodeBase64ToUint8Array } from "@/lib/utils";
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
    const hasConnectedRef = useRef(false);
    const isReadyRef = useRef(false);

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

        const term = new Terminal(getTerminalTheme(theme));
        const fitAddon = new FitAddon();
        const unicode11Addon = new Unicode11Addon();

        term.loadAddon(fitAddon);
        term.loadAddon(unicode11Addon);
        term.unicode.activeVersion = "11";
        term.open(container);

        terminalRef.current = term;
        fitAddonRef.current = fitAddon;

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
                    isReadyRef.current = true;
                    hasConnectedRef.current = true; // 仅成功后才标记，允许失败后重试
                    if (terminalRef.current && fitAddonRef.current) {
                        fitAddonRef.current.fit();
                        SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                            .catch(console.error);
                    }
                })
                .catch((err) => {
                    printErrorToTerminal(err);
                });
        }

        const onDataDisposable = term.onData((data) => {
            if (!isReadyRef.current) return;
            SshService.Input(sessionId, data).catch((err) => {
                printErrorToTerminal(err);
            });
        });

        // 唯一的 ResizeObserver：监听容器尺寸变化，防抖后 fit + resize
        // 处理所有场景：FilePanel 展开/折叠、窗口缩放、标签页切换
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!isReadyRef.current || !fitAddonRef.current || !terminalRef.current) return;
                try {
                    fitAddonRef.current.fit();
                    if (isActive) {
                        SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols)
                            .catch(() => {});
                    }
                } catch (e) {
                    // 容器尚未就绪等情况，忽略
                }
            }, 80);
        });
        resizeObserver.observe(container);

        return () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
            container.removeEventListener("contextmenu", handleContextMenu);
            onDataDisposable.dispose();
            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
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

    // SSH 数据事件
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            if (event.data.id === sessionId && terminalRef.current) {
                const rawBytes = decodeBase64ToUint8Array(event.data.data);
                terminalRef.current.write(rawBytes);
            }
        });
        return () => unsubscribe();
    }, [sessionId]);

    // 当文件面板显示/隐藏时，等布局稳定后强制 fit + refresh
    // xterm canvas 在容器尺寸突变时可能被清空，需要主动重绘
    useEffect(() => {
        if (!isActive || !isReadyRef.current) return;
        const timer = setTimeout(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            try {
                fitAddonRef.current.fit();
                SshService.Resize(sessionId, terminalRef.current.rows, terminalRef.current.cols).catch(() => {});
                // 强制重绘整个终端，防止 canvas 被清空后显示黑屏
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
