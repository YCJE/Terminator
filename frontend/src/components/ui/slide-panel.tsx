// 右侧侧滑面板 — 借鉴 Netcatty AsidePanel inline 模式
// 作为 flex 子元素，shrink-0 固定宽度，自然挤压主内容区
// 解决小窗口下表单被遮挡、Select 下拉框被裁剪的问题

import { X, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

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
    width?: number; // 面板宽度 px，默认 400
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
    width = 400,
}: SlidePanelProps) {
    if (!open) return null;

    return (
        <div
            className={cn(
                "flex h-full shrink-0 flex-col overflow-hidden",
                "border-l border-border/60 bg-background shadow-[-16px_0_32px_hsl(var(--foreground)/0.08)]",
                "slide-panel-enter"
            )}
            style={{ width: `${width}px` }}
        >
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
