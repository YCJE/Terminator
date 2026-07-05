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
}

export function TerminalInstance({sessionId, isActive, config}: TerminalInstanceProps) {
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

        // TODO think of something better
        // \x1b[0m = reset formatting
        // \x1b[31m = red
        console.log(appError)
        const translated = t("error_message", { message: appError.message, error: appError.detailsString })
        terminalRef.current.write(`\r\n\x1b[31m${translated}\x1b[0m\r\n`)
    };

    useEffect(() => {
        if (!containerRef.current || terminalRef.current) return;
        const container = containerRef.current;

        const term = new Terminal(getTerminalTheme(theme));
        const fitAddon = new FitAddon();
        const unicode11Addon = new Unicode11Addon();

        term.loadAddon(fitAddon);
        term.loadAddon(unicode11Addon);
        term.unicode.activeVersion = "11";
        term.open(containerRef.current);

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
        containerRef.current.addEventListener("contextmenu", handleContextMenu);

        if (!hasConnectedRef.current) {
            hasConnectedRef.current = true;
            SshService.Connect(config)
                .then(() => {
                    isReadyRef.current = true;

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

        // 监听容器尺寸变化（如 FilePanel 展开/折叠、窗口缩放），
        // 自动重新 fit 终端并通知 SSH 服务端调整 PTY 尺寸，
        // 否则 xterm.js canvas 会因尺寸不匹配而黑屏
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (!isReadyRef.current || !fitAddonRef.current || !terminalRef.current) return;
            // 防抖：快速连续变化时只执行最后一次
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                try {
                    fitAddonRef.current?.fit();
                    const t = terminalRef.current;
                    if (t) {
                        SshService.Resize(sessionId, t.rows, t.cols).catch(console.error);
                    }
                } catch (e) {
                    // 容器尚未就绪等情况，忽略
                }
            }, 100);
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
            SshService.Disconnect(sessionId).catch(() => {
            });
        };
    }, [sessionId, config]);

    // 主题切换时实时更新终端颜色
    useEffect(() => {
        const term = terminalRef.current;
        if (!term) return;
        const colors = getTerminalTheme(theme).theme;
        term.options.theme = colors;
        // 强制刷新渲染
        term.refresh(0, term.rows - 1);
    }, [theme]);

    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            if (event.data.id === sessionId && terminalRef.current) {
                const rawBytes = decodeBase64ToUint8Array(event.data.data);

                terminalRef.current.write(rawBytes);
            }
        });
        return () => unsubscribe();
    }, [sessionId]);

    useEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver(() => {
            if (!isActive || !isReadyRef.current) return;

            const fit = fitAddonRef.current;
            const term = terminalRef.current;
            if (!fit || !term) return;

            try {
                fit.fit();
                term.focus();
                SshService.Resize(sessionId, term.rows, term.cols).catch((err) => {
                    printErrorToTerminal(err);
                });
            } catch (e) {
                console.warn("xterm fit failed:", e);
            }
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, [isActive, sessionId]);

    // 当文件面板显示/隐藏时，终端容器宽度会变化，
    // 需要等布局稳定后重新 fit，否则 xterm canvas 会黑屏
    useEffect(() => {
        if (!isActive || !isReadyRef.current) return;
        const timer = setTimeout(() => {
            try {
                fitAddonRef.current?.fit();
                const term = terminalRef.current;
                if (term) {
                    SshService.Resize(sessionId, term.rows, term.cols).catch(() => {});
                }
            } catch (e) {
                // 忽略 fit 失败
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [isFilePanelVisible, isActive, sessionId]);

    return (
        <div className={cn("h-full w-full bg-background p-2", isActive ? "block" : "hidden")}>
            <div ref={containerRef} className="h-full w-full"/>
        </div>
    );
}