import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
    ClipboardPaste,
    Code2,
    Copy,
    Save,
    Search,
    TextCursorInput,
    Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TerminalContextMenuProps {
    open: boolean;
    /** 鼠标位置（视口坐标） */
    x: number;
    y: number;
    /** 是否有选中文本：无选区时"复制"置灰 */
    hasSelection: boolean;
    onClose: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onSelectAll: () => void;
    onFind: () => void;
    onSaveBuffer: () => void;
    onOpenCompose: () => void;
    /** 仅 SSH 会话提供：ZMODEM 上传本地文件到远端 */
    onZmodemUpload?: () => void;
}

/**
 * 终端右键菜单
 * 用 Portal 渲染到 body：终端窗格有 overflow 裁切，菜单直接放在窗格内
 * 会被截断。样式与标签页右键菜单保持一致（surface-2 + shadow-menu）。
 */
export function TerminalContextMenu({
    open,
    x,
    y,
    hasSelection,
    onClose,
    onCopy,
    onPaste,
    onSelectAll,
    onFind,
    onSaveBuffer,
    onOpenCompose,
    onZmodemUpload,
}: TerminalContextMenuProps) {
    const { t } = useTranslation("terminal");
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    // 按实际尺寸收敛到视口内：右下角右键时菜单不应超出屏幕。
    // 同时把焦点移到菜单上，避免菜单打开时键盘输入仍落到终端里。
    useLayoutEffect(() => {
        if (!open) return;
        const el = menuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - rect.width - 8));
        const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - rect.height - 8));
        setPos({ left, top });
        el.focus();
    }, [open, x, y]);

    // 点击外部、Esc、滚动或窗口失焦时关闭，避免菜单悬在终端上无法消失
    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            onClose();
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                // 阻止 Esc 继续传到终端，否则关闭菜单的同时还会向远端发送 Esc
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("resize", onClose);
        window.addEventListener("blur", onClose);
        window.addEventListener("wheel", onClose, { capture: true, passive: true });
        return () => {
            window.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("resize", onClose);
            window.removeEventListener("blur", onClose);
            window.removeEventListener("wheel", onClose, { capture: true });
        };
    }, [open, onClose]);

    if (!open) return null;

    const run = (action: () => void) => {
        onClose();
        action();
    };

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            className="fixed z-50 min-w-52 rounded-[var(--radius-lg)] border border-[var(--hairline)]
                       bg-[var(--surface-2)] p-1 shadow-[var(--shadow-menu)] outline-none"
            style={{ left: pos.left, top: pos.top }}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <MenuItem
                icon={Copy}
                label={t("ctx_copy")}
                hint="Ctrl+Shift+C"
                disabled={!hasSelection}
                onClick={() => run(onCopy)}
            />
            <MenuItem
                icon={ClipboardPaste}
                label={t("ctx_paste")}
                hint="Ctrl+Shift+V"
                onClick={() => run(onPaste)}
            />
            <MenuItem
                icon={TextCursorInput}
                label={t("ctx_select_all")}
                onClick={() => run(onSelectAll)}
            />

            <div className="my-1 h-px w-full bg-[var(--hairline)]"/>

            <MenuItem
                icon={Search}
                label={t("ctx_find")}
                onClick={() => run(onFind)}
            />
            <MenuItem
                icon={Save}
                label={t("ctx_save_buffer")}
                onClick={() => run(onSaveBuffer)}
            />
            <MenuItem
                icon={Code2}
                label={t("ctx_compose")}
                onClick={() => run(onOpenCompose)}
            />
            {onZmodemUpload && (
                <>
                    <div className="my-1 h-px w-full bg-[var(--hairline)]"/>
                    <MenuItem
                        icon={Upload}
                        label={t("ctx_zmodem_upload")}
                        onClick={() => run(onZmodemUpload)}
                    />
                </>
            )}
        </div>,
        document.body
    );
}

interface MenuItemProps {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    hint?: string;
    onClick: () => void;
    disabled?: boolean;
}

/** 菜单条目：图标 + 文本 + 可选快捷键提示，禁用态置灰且不可点击 */
function MenuItem({ icon: Icon, label, hint, onClick, disabled }: MenuItemProps) {
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                disabled
                    ? "cursor-default text-[var(--fg-subtle)] opacity-60"
                    : "text-[var(--fg-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
            )}
        >
            <Icon className="size-3.5 shrink-0"/>
            <span className="flex-1 truncate">{label}</span>
            {hint && (
                <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">{hint}</span>
            )}
        </button>
    );
}
