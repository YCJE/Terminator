import {
    Server,
    MoreHorizontal,
    Edit,
    Trash2,
    CircleDashed,
    Terminal,
    Infinity as InfinityIcon,
    Mountain,
    Triangle,
    AppWindow,
    Command,
    type LucideIcon,
} from "lucide-react";
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

interface OSIconInfo {
    Icon: LucideIcon;
    /** Brand color in hex; empty string means "use default primary styling". */
    color: string;
}

/**
 * Infer the operating system from the hostname / username and return the
 * matching lucide-react icon plus the OS brand color.
 *
 * Detection is purely heuristic — it looks at the lower-cased hostname and
 * username for known distro identifiers. When nothing matches we fall back
 * to the generic Server icon so existing cards keep their original look.
 */
function getOSIcon(hostname: string, username?: string): OSIconInfo {
    const h = (hostname || "").toLowerCase();
    const u = (username || "").toLowerCase();
    const combined = `${h} ${u}`;

    if (combined.includes("ubuntu")) return { Icon: CircleDashed, color: "#E95420" };
    if (combined.includes("debian")) return { Icon: Terminal, color: "#A81D33" };
    if (combined.includes("centos") || combined.includes("rhel")) return { Icon: Server, color: "#DC2A2A" };
    if (combined.includes("fedora")) return { Icon: InfinityIcon, color: "#294172" };
    if (combined.includes("alpine")) return { Icon: Mountain, color: "#0D597F" };
    if (combined.includes("arch")) return { Icon: Triangle, color: "#1793D1" };
    if (combined.includes("windows")) return { Icon: AppWindow, color: "#0078D6" };
    if (combined.includes("macos") || combined.includes("darwin")) return { Icon: Command, color: "#555555" };

    // Default — keep the original primary-tinted Server icon.
    return { Icon: Server, color: "" };
}

export function HostCard({host, onConnect, onEdit, onDelete}: HostCardProps) {
    const {t} = useTranslation("common");

    const {Icon: OSIcon, color: osColor} = getOSIcon(host.name || host.host, host.username);
    const isDefault = !osColor;

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
                <div
                    className={`flex size-10 shrink-0 items-center justify-center
                                rounded-lg transition-colors
                                group-hover:bg-primary/15 ${isDefault ? "bg-primary/10 text-primary" : ""}`}
                    style={
                        isDefault
                            ? undefined
                            : {
                                  backgroundColor: `${osColor}1a`,
                                  color: osColor,
                              }
                    }
                >
                    <OSIcon className="size-5" />
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
