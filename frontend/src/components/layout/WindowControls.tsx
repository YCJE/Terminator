import { useState, useEffect } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { Window, System } from "@wailsio/runtime";
import { cva } from "class-variance-authority";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const windowControlStyles = cva(
    "wails-no-drag inline-flex h-full w-12 items-center justify-center bg-transparent transition-colors",
    {
        variants: {
            intent: {
                default: "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg-strong)] active:bg-[var(--surface-3)]",
                close: "text-[var(--fg-muted)] hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)] active:brightness-90",
            }
        },
        defaultVariants: {intent: "default"}
    }
);

export function WindowControls({className = ""}) {
    const {t} = useTranslation("common");
    const [isMaximised, setIsMaximised] = useState(false);
    const [isWindows, setIsWindows] = useState(true);

    useEffect(() => {
        setIsWindows(System.IsWindows());

        // 窗口服务在窗口销毁/后端异常时会 reject，必须兜底，
        // 否则每次 resize 都会产生未处理的 Promise rejection。
        const refreshMaximised = () => {
            Window.IsMaximised().then(setIsMaximised).catch(() => setIsMaximised(false));
        };
        refreshMaximised();
        window.addEventListener("resize", refreshMaximised);
        return () => window.removeEventListener("resize", refreshMaximised);
    }, []);

    const handleToggleMaximise = async () => {
        // 动作可能被窗口管理器忽略或因平台限制失败；不盲目取反本地状态，
        // 而是以窗口的真实状态为准，避免按钮图标与实际窗口状态长期不一致。
        try {
            if (isMaximised) {
                await Window.Restore();
            } else {
                await Window.Maximise();
            }
        } catch {
            // 最大化/还原失败时保持现有状态，不做无意义的翻转
        }
        try {
            setIsMaximised(await Window.IsMaximised());
        } catch {
            // 读取失败时保留上一次已知状态
        }
    };

    if (!isWindows) return null;

    return (
        <div className={cn(
            "wails-no-drag flex h-full items-center",
                    className)}
        >
            <button
                type="button"
                tabIndex={-1}
                onClick={() => Window.Minimise()}
                className={cn(windowControlStyles())}
                title={t("window_minimize")}
                aria-label={t("window_minimize")}
            >
                <Minus className="size-4"/>
            </button>

            <button
                type="button"
                tabIndex={-1}
                onClick={handleToggleMaximise}
                className={cn(windowControlStyles())}
                title={isMaximised ? t("window_restore") : t("window_maximize")}
                aria-label={isMaximised ? t("window_restore") : t("window_maximize")}
            >
                {isMaximised ? <Copy className="size-3.5"/> : <Square className="size-3.5"/>}
            </button>

            <button
                type="button"
                tabIndex={-1}
                onClick={() => Window.Close()}
                className={cn(windowControlStyles({intent: "close"}))}
                title={t("window_close")}
                aria-label={t("window_close")}
            >
                <X className="size-4"/>
            </button>
        </div>
    );
}