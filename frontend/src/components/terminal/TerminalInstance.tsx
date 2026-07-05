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

        // ResizeObserver：监听容器尺寸变化
        // fit() 立即执行（视觉即时更新），SshService.Resize 防抖（避免频繁请求远端）
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (!fitAddonRef.current || !terminalRef.current) return;
            // 容器隐藏时（display:none）尺寸为 0，跳过 fit 避免异常
            if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
            // 立即 fit，让本地终端尺寸与容器同步
            try {
                fitAddonRef.current.fit();
            } catch (e) {
                return;
            }
            // 防抖发送远端 PTY resize，只在用户停止调整后发送最终尺寸
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
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
            container.removeEventListener("contextmenu", handleContextMenu);
            onDataDisposable.dispose();
            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            // 重置连接状态，允许 config 变化时重新连接
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

    // SSH 数据事件
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshData, (event) => {
            const data = event?.data as { id?: string; data?: string } | null;
            if (!data || data.id !== sessionId || !terminalRef.current) return;
            try {
                const rawBytes = decodeBase64ToUint8Array(data.data || "");
                terminalRef.current.write(rawBytes);
            } catch {
                // base64 解码失败时忽略该数据包
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
