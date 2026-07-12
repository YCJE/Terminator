import { X, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { TerminalSession } from "@/store/sessionStore";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface TerminalTabProps {
    session: TerminalSession;
    isActive: boolean;
    index: number;
    onClick: () => void;
    onClose: () => void;
    onDragStart: (index: number) => void;
    onDragOver: (index: number) => void;
    onDragEnd: () => void;
    onDrop: (index: number) => void;
    /** 设置标签页颜色，传空字符串清除颜色 */
    onSetColor: (color: string) => void;
}

/** 连接状态指示点颜色 */
function getStatusColor(status: string): string {
    switch (status) {
        case "connected":
            return "bg-emerald-400";
        case "connecting":
            return "bg-amber-400";
        case "disconnected":
            return "bg-rose-500";
        default:
            return "bg-muted-foreground";
    }
}

/**
 * 标签页颜色预设（8 色 + 无色）
 * 用于右键菜单中的颜色选择器，label 为 i18n key
 */
const TAB_COLOR_PRESETS: { value: string; labelKey: string }[] = [
    { value: "#ef4444", labelKey: "tab_color_red" },
    { value: "#f97316", labelKey: "tab_color_orange" },
    { value: "#eab308", labelKey: "tab_color_yellow" },
    { value: "#22c55e", labelKey: "tab_color_green" },
    { value: "#06b6d4", labelKey: "tab_color_cyan" },
    { value: "#3b82f6", labelKey: "tab_color_blue" },
    { value: "#a855f7", labelKey: "tab_color_purple" },
    { value: "#ec4899", labelKey: "tab_color_pink" },
];

export function TerminalTab({
    session,
    isActive,
    index,
    onClick,
    onClose,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
    onSetColor,
}: TerminalTabProps) {
    const { t } = useTranslation("terminal");
    const isDraggedOver = React.useRef(false);

    // 右键颜色选择菜单状态
    const [colorMenuOpen, setColorMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
    // 标记当前 contextmenu 事件来自本组件，避免 close 监听器误关闭自身菜单
    const skipCloseRef = useRef(false);

    // 点击页面任意位置关闭颜色菜单
    useEffect(() => {
        if (!colorMenuOpen) return;
        const close = (e: Event) => {
            // contextmenu 事件来自本标签页时跳过关闭（允许重新定位菜单）
            if (e.type === "contextmenu" && skipCloseRef.current) {
                skipCloseRef.current = false;
                return;
            }
            setColorMenuOpen(false);
        };
        // 延迟注册，避免触发本次 contextmenu 之后的 click 事件立即关闭
        const timer = setTimeout(() => {
            window.addEventListener("click", close);
            window.addEventListener("contextmenu", close);
        }, 0);
        return () => {
            clearTimeout(timer);
            window.removeEventListener("click", close);
            window.removeEventListener("contextmenu", close);
        };
    }, [colorMenuOpen]);

    /** 右键打开颜色选择菜单 */
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        // 标记本次 contextmenu 来自本组件，close 监听器应跳过
        skipCloseRef.current = true;
        // 不调用 stopPropagation，让 contextmenu 事件冒泡到 window，
        // 以便其他标签页的 close 监听器关闭已有菜单，避免多个菜单同时打开
        // 右键时选中该标签页（符合常见标签页交互习惯）
        onClick();
        // 计算菜单位置，确保不超出视口边界
        const x = Math.min(e.clientX, window.innerWidth - 180);
        const y = Math.min(e.clientY, window.innerHeight - 140);
        setMenuPos({ x, y });
        setColorMenuOpen(true);
    };

    /** 选择颜色 */
    const handlePickColor = (color: string) => {
        onSetColor(color);
        setColorMenuOpen(false);
    };

    return (
        <>
            <div
                onClick={onClick}
                onContextMenu={handleContextMenu}
                tabIndex={0}
                role="tab"
                aria-selected={isActive}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox 等浏览器要求 setData 才能正常触发拖拽
                    e.dataTransfer.setData("text/plain", String(index));
                    onDragStart(index);
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (!isDraggedOver.current) {
                        isDraggedOver.current = true;
                        onDragOver(index);
                    }
                }}
                onDragLeave={() => {
                    isDraggedOver.current = false;
                }}
                onDragEnd={() => {
                    isDraggedOver.current = false;
                    onDragEnd();
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    isDraggedOver.current = false;
                    onDrop(index);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onClick();
                    }
                }}
                className={cn(
                    "tab-enter wails-no-drag group relative flex h-7 min-w-28 max-w-48 cursor-pointer",
                    "items-center justify-between gap-1.5 px-2.5 text-xs font-medium",
                    "terminal-tab",
                    isActive ? "terminal-tab-active" : "terminal-tab-inactive"
                )}
            >
                {/* 自定义颜色指示条（标签页左侧彩色竖条） */}
                {session.color && (
                    <span
                        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full"
                        style={{ backgroundColor: session.color }}
                    />
                )}
                {/* 连接状态指示点（借鉴 Netcatty） */}
                <span
                    className={cn(
                        "size-1.5 shrink-0 rounded-full ring-2 ring-transparent",
                        getStatusColor(session.status || "connected"),
                        isActive && session.status === "connected" && "activity-dot"
                    )}
                />
                <span className="truncate flex-1">{session.title}</span>
                <button
                    type="button"
                    title="Close tab"
                    aria-label={`Close ${session.title}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                    className={cn(
                        "ml-1 flex size-4 items-center justify-center rounded-sm transition-all hover:bg-destructive/20",
                        isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    )}
                >
                    <X className="size-3"/>
                </button>
            </div>

            {/* 右键颜色选择菜单 —— 使用 Portal 渲染到 body，避免被 overflow:hidden 裁切 */}
            {colorMenuOpen && createPortal(
                <div
                    className="fixed z-50 min-w-44 rounded-lg border border-border bg-popover p-2 shadow-2xl"
                    style={{ left: menuPos.x, top: menuPos.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {/* 菜单标题 */}
                    <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">
                        {t("tab_color")}
                    </div>
                    {/* 颜色网格 */}
                    <div className="grid grid-cols-4 gap-1.5">
                        {TAB_COLOR_PRESETS.map((preset) => (
                            <button
                                key={preset.value}
                                onClick={() => handlePickColor(preset.value)}
                                className={cn(
                                    "size-6 rounded-md transition-all hover:scale-110",
                                    session.color === preset.value
                                        ? "ring-2 ring-foreground ring-offset-1 ring-offset-popover"
                                        : "ring-1 ring-border"
                                )}
                                style={{ backgroundColor: preset.value }}
                                title={t(preset.labelKey)}
                                aria-label={t(preset.labelKey)}
                            />
                        ))}
                    </div>
                    {/* 分隔线 */}
                    <div className="my-2 h-px w-full bg-border"/>
                    {/* 清除颜色按钮 */}
                    <button
                        onClick={() => handlePickColor("")}
                        className={cn(
                            "flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
                            !session.color
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        )}
                    >
                        <Ban className="size-3.5"/>
                        {t("tab_color_none")}
                    </button>
                </div>,
                document.body
            )}
        </>
    );
}
