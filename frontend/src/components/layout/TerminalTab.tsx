import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TerminalSession } from "@/store/sessionStore";

interface TerminalTabProps {
    session: TerminalSession;
    isActive: boolean;
    onClick: () => void;
    onClose: () => void;
}

export function TerminalTab({session, isActive, onClick, onClose}: TerminalTabProps) {
    return (
        <div onClick={onClick}
             tabIndex={0}
             role="tab"
             aria-selected={isActive}
             onKeyDown={(e) => {
                 if (e.key === "Enter" || e.key === " ") {
                     e.preventDefault();
                     onClick();
                 }
             }}
             className={cn(
                 "tab-enter wails-no-drag group flex h-8 min-w-30 max-w-50 cursor-pointer",
                 "items-center justify-between px-3 text-xs font-medium",
                 "terminal-tab",
                 isActive ? "terminal-tab-active" : "terminal-tab-inactive"
             )}>
            <span className="truncate">{session.title}</span>
            <button
                type="button"
                title="Close tab"
                aria-label={`Close ${session.title}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                }}
                className={cn(
                    "ml-2 flex size-5 items-center justify-center rounded-sm transition-all hover:bg-destructive/20",
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                )}
            >
                <X className="size-3"/>
            </button>
        </div>
    );
}
