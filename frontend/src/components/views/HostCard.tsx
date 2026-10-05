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
    /** Brand color in hex; empty string means "use default muted styling". */
    color: string;
}

/**
 * Infer the operating system from the hostname / username and return the
 * matching lucide-react icon plus the OS brand color.
 *
 * Detection is purely heuristic — it looks at the lower-cased hostname and
 * username for known distro identifiers. When nothing matches we fall back
 * to the generic Server icon so existing rows keep their original look.
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

    // Default — keep the original muted Server icon.
    return { Icon: Server, color: "" };
}

export function HostCard({host, onConnect, onEdit, onDelete}: HostCardProps) {
    const {t} = useTranslation(["common", "hosts"]);

    const {Icon: OSIcon, color: osColor} = getOSIcon(host.name || host.host, host.username);
    const isDefault = !osColor;

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onConnect(host)}
            onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    onConnect(host);
                }
            }}
            className="list-row is-interactive group"
        >
            <span
                className={`list-chip${isDefault ? "" : " is-tinted"}`}
                style={isDefault ? undefined : ({"--chip-tint": osColor} as React.CSSProperties)}
            >
                <OSIcon className="size-3.5"/>
            </span>

            <span className="list-name">{host.name || host.host}</span>

            <span className="list-mono">
                <b>{host.username}</b><span>@</span>{host.host}{host.port && host.port !== 22 ? `:${host.port}` : ""}
            </span>

            {host.jumpHostId && <span className="list-tag is-info">{t("hosts:tag_jump")}</span>}
            {host.proxyType && <span className="list-tag is-warning">{t("hosts:tag_proxy")}</span>}

            <div className="list-actions" onClick={(e) => e.stopPropagation()}>
                <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="size-4 text-[var(--fg-muted)]"/>
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