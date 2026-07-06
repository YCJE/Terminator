// 右侧侧滑面板 — 借鉴 Netcatty AsidePanel inline 模式
// 作为 flex 子元素，shrink-0 固定宽度，自然挤压主内容区
// 支持左边缘拖拽调整宽度

import { useState, useRef, useCallback, useEffect } from "react";
import { X, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_WIDTH = 380;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 460;
const STORAGE_KEY = "slide-panel-width";

interface SlidePanelProps {
    open: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    onBack?: () => void;
    showBackButton?: boolean;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    children: React.ReactNode;
}

export function SlidePanel({
    open,
    onClose,
    title,
    subtitle,
    onBack,
    showBackButton = false,
    actions,
    footer,
    children,
}: SlidePanelProps) {
    const [width, setWidth] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        const parsed = saved ? parseInt(saved, 10) : NaN;
        return isNaN(parsed) ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed));
    });
    const draggingRef = useRef(false);
    // 用 ref 跟踪最新宽度，避免闭包过期 + 减少 effect 重建
    const widthRef = useRef(width);
    widthRef.current = width;

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        draggingRef.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    useEffect(() => {
        if (!open) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - e.clientX));
            setWidth(newWidth);
            widthRef.current = newWidth;
        };

        const handleMouseUp = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            // 从 ref 读取最新宽度，避免闭包过期
            localStorage.setItem(STORAGE_KEY, String(widthRef.current));
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [open]); // 仅依赖 open，拖拽期间不重建监听器

    if (!open) return null;

    return (
        <div
            className={cn(
                "relative flex h-full shrink-0 flex-col overflow-hidden",
                "border-l border-border/60 bg-background shadow-[-16px_0_32px_hsl(var(--foreground)/0.08)]",
                "slide-panel-enter"
            )}
            style={{ width: `${width}px` }}
        >
            {/* 左边缘拖拽手柄 */}
            <div
                onMouseDown={handleMouseDown}
                className="absolute left-0 top-0 z-40 h-full w-1.5 cursor-col-resize hover:bg-primary/40 transition-colors"
            />

            {/* Header — 固定高度 */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    {showBackButton && onBack && (
                        <button
                            onClick={onBack}
                            className="cursor-pointer rounded-md p-1 transition-colors hover:bg-muted"
                        >
                            <ArrowLeft className="size-4" />
                        </button>
                    )}
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{title}</h3>
                        {subtitle && (
                            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {actions}
                    <button
                        onClick={onClose}
                        className="cursor-pointer rounded-md p-1.5 transition-colors hover:bg-muted"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            </div>

            {/* Content — 可滚动区域 */}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                <div className="space-y-4 p-4">
                    {children}
                </div>
            </div>

            {/* Footer — 固定高度（可选） */}
            {footer && (
                <div className="shrink-0 border-t border-border/60 px-4 py-3">
                    {footer}
                </div>
            )}
        </div>
    );
}
