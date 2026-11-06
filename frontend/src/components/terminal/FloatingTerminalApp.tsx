// 浮动终端窗口的独立入口。
//
// 该窗口由 Go 侧 floating.Service 创建，URL 形如 /#/floating?token=xxx。
// 窗口不是新的连接：它通过 token 取回会话 ID，以"附着"模式接管已在运行的
// SSH/本地终端会话，因此弹出/收回都不会打断正在运行的命令。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Window } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Link2, Minus, Pin, PinOff, RotateCw, X } from "lucide-react";
import i18n from "@/i18n";
import { Service as FloatingService } from "../../../bindings/terminator-desktop/backend/internal/services/floating";
import { SSHConnectionConfig } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { TerminalInstance } from "@/components/terminal/TerminalInstance";
import { Toaster } from "@/components/ui/sonner";
import { applyAppearanceToDocument, isDarkAppearance, syncAppearanceFromSettings } from "@/lib/appAppearance";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";
import type { SessionKind } from "@/store/sessionStore";

type ReadyState = {
    status: "ready";
    token: string;
    sessionId: string;
    title: string;
    kind: SessionKind;
    config: SSHConnectionConfig;
    /** true：附着到已有会话；false：窗口打开时重新建立连接 */
    attach: boolean;
};

type LoadState = { status: "loading" } | { status: "error"; message: string } | ReadyState;

/** 从 URL fragment 读取窗口 token：#/floating?token=xxx */
function readFloatingToken(): string {
    const hash = window.location.hash;
    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    return new URLSearchParams(query).get("token") ?? "";
}

/** 窗口顶部工具栏按钮：与主窗口的窗口控制保持同样的尺寸与反馈 */
function HeaderButton({
    label,
    active,
    danger,
    disabled,
    onClick,
    children,
}: {
    label: string;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "wails-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[var(--fg-muted)] transition-colors",
                "hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]",
                active && "bg-[var(--surface-3)] text-[var(--fg-strong)]",
                danger && "hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)]",
                disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-[var(--fg-muted)]",
            )}
        >
            {children}
        </button>
    );
}

export function FloatingTerminalApp() {
    const { t } = useTranslation("terminal");
    const { t: tCommon } = useTranslation("common");
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const [alwaysOnTop, setAlwaysOnTop] = useState(false);
    const [disconnected, setDisconnected] = useState(false);
    // 显式重连计数：递增后终端会重新建立连接（而不是继续附着到旧会话）
    const [reconnectNonce, setReconnectNonce] = useState(0);

    const theme = useUIStore((s) => s.theme);
    const accentColor = useUIStore((s) => s.accentColor);
    const spaciness = useUIStore((s) => s.spaciness);
    const skin = useUIStore((s) => s.skin);
    const dark = isDarkAppearance(theme, skin);

    // 外观与语言：浮动窗口是独立 webview，需要自己同步一次后端设置
    useEffect(() => {
        void syncAppearanceFromSettings().catch(console.error);
    }, []);
    useEffect(() => {
        applyAppearanceToDocument();
    }, [theme, accentColor, spaciness, skin]);

    // 取回启动参数。只执行一次：state 变化不能重跑，否则会新建 config 对象
    // 触发终端组件的重连。
    useEffect(() => {
        let cancelled = false;
        const token = readFloatingToken();
        if (!token) {
            setState({ status: "error", message: i18nMessage("float_invalid") });
            return;
        }
        FloatingService.TakeFloatingTerminal(token)
            .then((payload) => {
                if (cancelled) return;
                if (!payload?.sessionId) {
                    setState({ status: "error", message: i18nMessage("float_invalid") });
                    return;
                }
                const kind: SessionKind = payload.kind === "local" ? "local" : "ssh";
                const config = new SSHConnectionConfig({
                    ...(kind === "local" ? {} : payload.config ?? {}),
                    id: payload.sessionId,
                    host: kind === "local" ? "local" : payload.config?.host ?? "",
                    port: kind === "local" ? 0 : payload.config?.port ?? 22,
                    username: kind === "local" ? "" : payload.config?.username ?? "",
                });
                setState({
                    status: "ready",
                    token,
                    sessionId: payload.sessionId,
                    title: payload.title,
                    kind,
                    config,
                    attach: payload.attach,
                });
            })
            .catch((err) => {
                console.error("读取浮动窗口参数失败:", err);
                if (!cancelled) setState({ status: "error", message: i18nMessage("float_invalid") });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // 断开状态完全由 TerminalInstance 上报（onConnectionLost）：它区分了
    // "重连前主动断开旧连接"与"真正的意外断开"。此处不再单独监听 SshClosed，
    // 否则重连时旧连接的 closed 事件会把刚恢复的会话重新标成已断开。

    const subtitle = useMemo(() => {
        if (state.status !== "ready") return "";
        if (state.kind === "local") return t("local_terminal_title");
        const { host, port, username } = state.config;
        return `${username ? `${username}@` : ""}${host}${port && port !== 22 ? `:${port}` : ""}`;
    }, [state, t]);

    if (state.status !== "ready") {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-[var(--surface-0)] px-6 text-center">
                <p className={cn(
                    "text-xs",
                    state.status === "error" ? "text-[var(--destructive)]" : "text-[var(--fg-muted)]"
                )}>
                    {state.status === "error" ? state.message : t("float_loading")}
                </p>
            </div>
        );
    }

    const handleToggleTop = () => {
        const next = !alwaysOnTop;
        setAlwaysOnTop(next);
        FloatingService.SetFloatingAlwaysOnTop(state.token, next).catch(console.error);
    };

    const handleDock = () => {
        // 会话仍在运行时直接附着；已断开则让主窗口重新连接
        FloatingService.DockBack(state.token, !disconnected)
            .then(() => Window.Close())
            .catch((err) => {
                console.error("收回标签栏失败:", err);
            });
    };

    const handleReconnect = () => {
        setDisconnected(false);
        setReconnectNonce((n) => n + 1);
    };

    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--surface-0)] text-[var(--fg-strong)]">
            <header
                className="wails-drag flex h-9 shrink-0 items-center gap-2 border-b border-[var(--hairline)]
                           bg-[var(--surface-1)] pl-3"
            >
                <span
                    className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        disconnected ? "bg-[var(--destructive)]" : "bg-[var(--success)]"
                    )}
                />
                <span className="truncate text-xs text-[var(--fg-strong)]">{state.title}</span>
                <span className="truncate text-[10.5px] text-[var(--fg-subtle)]">{subtitle}</span>
                <Link2
                    className="size-3 shrink-0 text-[var(--fg-subtle)]"
                    aria-label={t("float_attached")}
                />
                {disconnected && (
                    <button
                        type="button"
                        onClick={handleReconnect}
                        className="wails-no-drag rounded-full bg-[var(--destructive)]/15 px-2 py-px text-[10px]
                                   text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/25"
                    >
                        {t("float_disconnected")}
                    </button>
                )}
                <div className="ml-auto flex h-full items-center gap-0.5 pr-1.5">
                    <HeaderButton label={t("float_reconnect")} onClick={handleReconnect}>
                        <RotateCw className="size-3.5"/>
                    </HeaderButton>
                    <HeaderButton
                        label={alwaysOnTop ? t("float_unpin") : t("float_pin")}
                        active={alwaysOnTop}
                        onClick={handleToggleTop}
                    >
                        {alwaysOnTop ? <PinOff className="size-3.5"/> : <Pin className="size-3.5"/>}
                    </HeaderButton>
                    <HeaderButton label={t("float_dock")} onClick={handleDock}>
                        <ArrowDownToLine className="size-3.5"/>
                    </HeaderButton>
                    <HeaderButton label={tCommon("window_minimize")} onClick={() => Window.Minimise()}>
                        <Minus className="size-4"/>
                    </HeaderButton>
                    <HeaderButton label={tCommon("window_close")} danger onClick={() => Window.Close()}>
                        <X className="size-4"/>
                    </HeaderButton>
                </div>
            </header>

            <div className="relative min-h-0 flex-1">
                <TerminalInstance
                    sessionId={state.sessionId}
                    config={state.config}
                    sessionKind={state.kind}
                    isVisible
                    isFocused
                    disconnected={disconnected}
                    reconnectNonce={reconnectNonce}
                    attachOnMount={state.attach}
                    onReconnectRequest={handleReconnect}
                    onConnectionLost={() => setDisconnected(true)}
                    className="inset-0"
                />
            </div>

            <Toaster
                position="bottom-right"
                theme={dark ? "dark" : "light"}
                richColors
                style={{zIndex: 9999}}
            />
        </div>
    );
}

/** 用于异步加载失败的兜底文案：不依赖 t 的引用变化 */
function i18nMessage(key: string): string {
    return i18n.t(`terminal:${key}`) as string;
}
