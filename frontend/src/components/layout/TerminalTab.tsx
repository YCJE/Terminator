import {
    X,
    Ban,
    CheckCircle2,
    Pencil,
    Copy,
    RotateCw,
    Terminal as TerminalIcon,
    PanelRightClose,
    XCircle,
    Radio,
    AppWindow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isNetConnKind, isSshKind } from "@/lib/sessionBackend";
import { TerminalSession, useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Clipboard } from "@wailsio/runtime";
import { toast } from "sonner";

interface TerminalTabProps {
    session: TerminalSession;
    isActive: boolean;
    index: number;
    /** 正在被拖动（降低透明度） */
    isDragging?: boolean;
    /** 拖拽落点：before 在左侧、after 在右侧显示插入标记 */
    dropSide?: "before" | "after";
    onClick: () => void;
    onClose: () => void;
    /** 重命名标签 */
    onRename: (title: string) => void;
    /** 复制会话（相同连接参数新开一个标签） */
    onDuplicate: () => void;
    /** 重连当前会话 */
    onReconnect: () => void;
    /** 把会话移到独立的浮动窗口 */
    onFloat: () => void;
    /** 关闭除本标签外的其他标签 */
    onCloseOthers: () => void;
    /** 关闭本标签右侧的所有标签 */
    onCloseRight: () => void;
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
            return "bg-[var(--success)]";
        case "connecting":
            return "bg-[var(--warning)]";
        case "disconnected":
            return "bg-[var(--destructive)]";
        default:
            return "bg-[var(--fg-subtle)]";
    }
}

/**
 * 标签页颜色预设（8 色）
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

/** 按主机配置生成可直接粘贴到外部终端的 ssh 命令 */
function buildSshCommand(session: TerminalSession): string {
    const { host, port, username } = session.config;
    const user = username ? `${username}@` : "";
    const portArg = port && port !== 22 ? ` -p ${port}` : "";
    return `ssh ${user}${host}${portArg}`;
}

export function TerminalTab({
    session,
    isActive,
    index,
    isDragging,
    dropSide,
    onClick,
    onClose,
    onRename,
    onDuplicate,
    onReconnect,
    onFloat,
    onCloseOthers,
    onCloseRight,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
    onSetColor,
}: TerminalTabProps) {
    const { t } = useTranslation("terminal");
    const tabColorEnabled = useUIStore((s) => s.tabColorEnabled);
    // 广播模式与排除列表：允许单个标签退出广播，保护生产机不被误输入
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const broadcastExcluded = useSessionStore((s) => s.broadcastExcluded);
    const toggleBroadcastSession = useSessionStore((s) => s.toggleBroadcastSession);
    const broadcastJoined = broadcastMode && !broadcastExcluded.includes(session.id);
    const isDraggedOver = React.useRef(false);

    // 右键菜单状态
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
    // 标记当前 contextmenu 事件来自本组件，避免 close 监听器误关闭自身菜单
    const skipCloseRef = useRef(false);

    // 原地重命名状态
    const [renaming, setRenaming] = useState(false);
    const [draftTitle, setDraftTitle] = useState(session.title);
    const renameInputRef = useRef<HTMLInputElement>(null);

    // 点击页面任意位置关闭右键菜单
    useEffect(() => {
        if (!menuOpen) return;
        const close = (e: Event) => {
            // contextmenu 事件来自本标签页时跳过关闭（允许重新定位菜单）
            if (e.type === "contextmenu" && skipCloseRef.current) {
                skipCloseRef.current = false;
                return;
            }
            setMenuOpen(false);
        };
        // 延迟注册，避免触发本次 contextmenu 之后的 click 事件立即关闭
        const timer = setTimeout(() => {
            window.addEventListener("click", close);
            window.addEventListener("contextmenu", close);
            // 菜单打开时按 Esc 关闭
            window.addEventListener("keydown", closeOnEscape);
        }, 0);
        function closeOnEscape(e: KeyboardEvent) {
            if (e.key === "Escape") setMenuOpen(false);
        }
        return () => {
            clearTimeout(timer);
            window.removeEventListener("click", close);
            window.removeEventListener("contextmenu", close);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [menuOpen]);

    // 进入重命名后聚焦并全选，避免用户还要点一次输入框
    useEffect(() => {
        if (!renaming) return;
        const input = renameInputRef.current;
        if (input) {
            input.focus();
            input.select();
        }
    }, [renaming]);

    const startRename = () => {
        setDraftTitle(session.title);
        setRenaming(true);
    };

    const commitRename = () => {
        const next = draftTitle.trim();
        if (next && next !== session.title) {
            onRename(next);
        }
        setRenaming(false);
    };

    const cancelRename = () => {
        setDraftTitle(session.title);
        setRenaming(false);
    };

    /** 右键打开菜单并选中该标签 */
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        skipCloseRef.current = true;
        onClick();
        // 估算菜单高度（随功能项数量变化），做视口边界收敛
        const estimatedHeight = tabColorEnabled ? 470 : 340;
        const estimatedWidth = 200;
        const x = Math.min(e.clientX, window.innerWidth - estimatedWidth - 8);
        const y = Math.min(e.clientY, window.innerHeight - estimatedHeight - 8);
        setMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
        setMenuOpen(true);
    };

    /** 执行菜单动作：先关菜单，避免点击后残留 */
    const run = (action: () => void) => {
        setMenuOpen(false);
        action();
    };

    const handlePickColor = (color: string) => {
        onSetColor(color);
        setMenuOpen(false);
    };

    const handleCopySshCommand = () => {
        Clipboard.SetText(buildSshCommand(session))
            .then(() => toast.success(t("copy_ssh_command_copied")))
            .catch(console.error);
    };

    return (
        <>
            <div
                onClick={onClick}
                onContextMenu={handleContextMenu}
                // 中键关闭：符合浏览器/终端标签的通用习惯
                onAuxClick={(e) => {
                    if (e.button === 1) {
                        e.preventDefault();
                        onClose();
                    }
                }}
                onMouseDown={(e) => {
                    // 阻止中键触发的自动滚动模式
                    if (e.button === 1) e.preventDefault();
                }}
                tabIndex={0}
                role="tab"
                aria-selected={isActive}
                // 供标签栏把激活标签滚入视口
                data-tab-id={session.id}
                // 重命名期间禁用拖拽，否则在输入框里选文字会触发标签拖拽
                draggable={!renaming}
                onDragStart={(e) => {
                    if (renaming) {
                        e.preventDefault();
                        return;
                    }
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
                    if (renaming) return;
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onClick();
                    }
                }}
                className={cn(
                    "tab-enter shell-tab wails-no-drag group relative flex min-w-28 max-w-48 cursor-pointer",
                    // 字重固定 400：中文回退字体（Microsoft YaHei UI）只有 400/700 两档，
                    // font-medium(500) 会被直接取整成 400，导致标签内中文比拉丁字母细一档；
                    // 统一 400 让中英文粗细一致（Termius 标签同样是常规字重）。
                    "items-center justify-between gap-1.5 px-2.5 text-xs font-normal",
                    "terminal-tab",
                    isActive ? "terminal-tab-active" : "terminal-tab-inactive",
                    isDragging && "is-dragging",
                    dropSide === "before" && "is-drop-before",
                    dropSide === "after" && "is-drop-after"
                )}
            >
                {/* 自定义颜色指示条（标签页左侧彩色竖条） */}
                {session.color && (
                    <span
                        className="absolute left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full"
                        style={{ backgroundColor: session.color }}
                    />
                )}
                {/* 连接状态指示点（借鉴 Netcatty） */}
                <span
                    className={cn(
                        "size-1.5 shrink-0 rounded-full ring-2 ring-transparent",
                        getStatusColor(session.status || "connected")
                    )}
                />
                {renaming ? (
                    <input
                        ref={renameInputRef}
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={commitRename}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                            // 输入框内的按键不冒泡给标签的 Enter/Space 处理
                            e.stopPropagation();
                            if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename();
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelRename();
                            }
                        }}
                        className="min-w-0 flex-1 rounded-sm border border-[var(--hairline-strong)]
                                   bg-[var(--surface-0)] px-1 py-0 text-xs text-[var(--fg-strong)] outline-none"
                        aria-label={t("tab_menu_rename")}
                    />
                ) : (
                    <span
                        className="truncate flex-1"
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRename();
                        }}
                    >
                        {session.title}
                    </span>
                )}
                {/* 广播参与标记：一眼看出哪些会话会同步接收输入 */}
                {broadcastJoined && !isActive && !renaming && (
                    <Radio
                        className="size-3 shrink-0 text-[var(--warning)]"
                        aria-label={t("tab_broadcast_active")}
                    />
                )}
                {/* 命令完成标记：远端上报 OSC 133;D 后，非当前标签显示完成提醒 */}
                {session.commandDone && !isActive && !renaming && (
                    <CheckCircle2
                        className="size-3 shrink-0 text-[var(--success)]"
                        aria-label={t("tab_command_done")}
                    />
                )}
                {/* 活动标记：后台会话有新输出时闪动，切换到该标签后清除 */}
                {session.hasActivity && !isActive && !renaming && (
                    <span
                        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--fg-strong)]"
                        aria-label={t("tab_new_activity")}
                    />
                )}
                <button
                    type="button"
                    title={t("tab_menu_close")}
                    aria-label={`${t("tab_menu_close")}: ${session.title}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                    className={cn(
                        "ml-1 flex size-4 items-center justify-center rounded-sm text-[var(--fg-muted)]",
                        "transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)] active:bg-[var(--surface-3)]",
                        isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    )}
                >
                    <X className="size-3"/>
                </button>
            </div>

            {/* 右键菜单 —— Portal 渲染到 body，避免被标签栏的 overflow:hidden 裁切 */}
            {menuOpen && createPortal(
                <div
                    className="fixed z-50 min-w-48 rounded-[var(--radius-lg)] border border-[var(--hairline)]
                               bg-[var(--surface-2)] p-1 shadow-[var(--shadow-menu)]"
                    style={{ left: menuPos.x, top: menuPos.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                    role="menu"
                >
                    <MenuItem
                        icon={Pencil}
                        label={t("tab_menu_rename")}
                        onClick={() => run(startRename)}
                    />
                    <MenuItem
                        icon={Copy}
                        label={t("tab_menu_duplicate")}
                        onClick={() => run(onDuplicate)}
                    />
                    <MenuItem
                        icon={RotateCw}
                        label={t("tab_menu_reconnect")}
                        onClick={() => run(onReconnect)}
                    />
                    {/* 浮动窗口目前只接管 SSH 与本地会话；Telnet / 串口没有可传递的连接参数 */}
                    {!isNetConnKind(session.kind) && (
                        <MenuItem
                            icon={AppWindow}
                            label={t("tab_menu_float")}
                            onClick={() => run(onFloat)}
                        />
                    )}
                    {isSshKind(session.kind) && (
                        <MenuItem
                          icon={TerminalIcon}
                          label={t("tab_menu_copy_ssh")}
                          onClick={() => run(handleCopySshCommand)}
                        />
                    )}
                    <MenuItem
                        icon={Radio}
                        label={broadcastExcluded.includes(session.id)
                            ? t("tab_menu_broadcast_join")
                            : t("tab_menu_broadcast_leave")}
                        onClick={() => run(() => toggleBroadcastSession(session.id))}
                    />

                    {/* 颜色选择：沿用设置中的"标签页自定义颜色"开关 */}
                    {tabColorEnabled && (
                        <>
                            <div className="my-1 h-px w-full bg-[var(--hairline)]"/>
                            <div className="px-2 pt-1 text-[10.5px] text-[var(--fg-subtle)]">
                                {t("tab_color")}
                            </div>
                            <div className="grid grid-cols-5 gap-1.5 px-2 py-1.5">
                                {TAB_COLOR_PRESETS.map((preset) => (
                                    <button
                                        key={preset.value}
                                        onClick={() => handlePickColor(preset.value)}
                                        className={cn(
                                            "size-5 rounded-md transition-all hover:scale-110",
                                            session.color === preset.value
                                                ? "ring-2 ring-[var(--fg-strong)] ring-offset-1 ring-offset-[var(--surface-2)]"
                                                : "ring-1 ring-[var(--hairline-strong)]"
                                        )}
                                        style={{ backgroundColor: preset.value }}
                                        title={t(preset.labelKey)}
                                        aria-label={t(preset.labelKey)}
                                    />
                                ))}
                                <button
                                    onClick={() => handlePickColor("")}
                                    className={cn(
                                        "flex size-5 items-center justify-center rounded-md ring-1 transition-colors",
                                        !session.color
                                            ? "bg-[var(--surface-3)] text-[var(--fg-strong)] ring-[var(--fg-strong)]"
                                            : "text-[var(--fg-muted)] ring-[var(--hairline-strong)] hover:text-[var(--fg-strong)]"
                                    )}
                                    title={t("tab_color_none")}
                                    aria-label={t("tab_color_none")}
                                >
                                    <Ban className="size-3"/>
                                </button>
                            </div>
                        </>
                    )}

                    <div className="my-1 h-px w-full bg-[var(--hairline)]"/>
                    <MenuItem
                        icon={XCircle}
                        label={t("tab_menu_close_others")}
                        onClick={() => run(onCloseOthers)}
                    />
                    <MenuItem
                        icon={PanelRightClose}
                        label={t("tab_menu_close_right")}
                        onClick={() => run(onCloseRight)}
                    />
                    <MenuItem
                        icon={X}
                        label={t("tab_menu_close")}
                        onClick={() => run(onClose)}
                        danger
                    />
                </div>,
                document.body
            )}
        </>
    );
}

interface MenuItemProps {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    onClick: () => void;
    danger?: boolean;
}

/** 右键菜单条目：图标 + 文本，危险操作用警示色 */
function MenuItem({ icon: Icon, label, onClick, danger }: MenuItemProps) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                danger
                    ? "text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                    : "text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
            )}
        >
            <Icon className="size-3.5 shrink-0"/>
            <span className="truncate">{label}</span>
        </button>
    );
}
