import { Server, MoreHorizontal, Edit, Trash2 } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Host } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { useTranslation } from "react-i18next";

interface HostCardProps {
    host: Host;
    onConnect: (host: Host) => void;
    onEdit: (host: Host) => void;
    onDelete: (host: Host) => void;
}

export function HostCard({host, onConnect, onEdit, onDelete}: HostCardProps) {
    const {t} = useTranslation("common");

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
    };

    return (
        <div
            tabIndex={0}
            onMouseMove={handleMouseMove}
            onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    onConnect(host);
                }
            }}
            className="soft-card card-highlight elevate group flex flex-row justify-between
                       rounded-xl
                       hover:border-primary/40
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <div
                onClick={() => onConnect(host)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 p-5"
            >
                <div className="flex size-10 shrink-0 items-center justify-center
                                rounded-lg bg-primary/10 text-primary transition-colors
                                group-hover:bg-primary/15">
                    <Server className="size-5" />
                </div>
                <div className="flex min-w-0 flex-col gap-0.5 pr-4">
                    <h3 className="truncate font-semibold text-card-foreground">
                        {host.name || host.host}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                        {host.username}<span className="text-muted-foreground/50"> @ </span>{host.host}{host.port && host.port !== 22 ? `:${host.port}` : ""}
                    </p>
                </div>
            </div>

            <div className="flex shrink-0 items-center pr-4">
                <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-0 transition-opacity
                                       group-hover:opacity-100 data-[state=open]:opacity-100
                                       focus-visible:opacity-100"
                        >
                            <MoreHorizontal className="size-4 text-muted-foreground"/>
                        </Button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent align="end" className="w-40 z-50">
                        <DropdownMenuItem onClick={() => onEdit(host)}>
                            <Edit className="mr-2 size-4"/>
                            {t("edit")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem
                            onClick={() => onDelete(host)}
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                            <Trash2 className="mr-2 size-4"/>
                            {t("delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

        </div>
    );
}