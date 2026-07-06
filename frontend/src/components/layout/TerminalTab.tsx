import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TerminalSession } from "@/store/sessionStore";
import React from "react";

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
}: TerminalTabProps) {
    const isDraggedOver = React.useRef(false);

    return (
        <div
            onClick={onClick}
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
                "tab-enter wails-no-drag group flex h-7 min-w-28 max-w-48 cursor-pointer",
                "items-center justify-between gap-1.5 px-2.5 text-xs font-medium",
                "terminal-tab",
                isActive ? "terminal-tab-active" : "terminal-tab-inactive"
            )}
        >
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
    );
}
