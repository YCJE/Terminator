// 右侧侧滑面板 — 借鉴 Netcatty AsidePanel
// absolute 定位浮层 + 主内容区 margin 避让 + Header/ScrollArea/Footer 三段式
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
        <>
            {/* 面板本体 — absolute 定位浮在右侧 */}
            <div
                className={cn(
                    "absolute bottom-0 right-0 top-0 z-30 flex max-w-full flex-col overflow-hidden",
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
        </>
    );
}

/**
 * 用于主内容区的 margin 避让样式
 * 当 SlidePanel 打开时，主内容区添加右边距避免被面板覆盖
 */
export function panelMarginStyle(open: boolean, width: number = 400): React.CSSProperties | undefined {
    if (!open) return undefined;
    return { marginRight: `${width}px` };
}
