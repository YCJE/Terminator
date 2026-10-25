import {
    Server,
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
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Host } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface HostCardProps {
    host: Host;
    selected?: boolean;
    onSelect: (host: Host) => void;
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
 */
export function getOSIcon(hostname: string, username?: string): OSIconInfo {
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

    return { Icon: Server, color: "" };
}

/**
 * Termius 风格主机卡片：系统图标 + 名称 + 副行。
 * 名称下方显示分组（Termius 对应位置为标签）；单击选中并打开右侧详情，
 * 双击直接连接，右键弹出快捷菜单。
 */
export function HostCard({host, selected, onSelect, onConnect, onEdit, onDelete}: HostCardProps) {
    const {t} = useTranslation(["common", "hosts"]);

    const {Icon: OSIcon, color: osColor} = getOSIcon(host.name || host.host, host.username);
    const endpoint = `${host.username}@${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
    const subtitle = host.group?.trim() || endpoint;

    return (
        <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger asChild>
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(host)}
                    onDoubleClick={() => onConnect(host)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) {
                            e.preventDefault();
                            onConnect(host);
                        }
                    }}
                    className={cn("card-tile", selected && "is-selected")}
                    title={endpoint}
                >
                    <span
                        className="card-tile-icon is-plain"
                        style={{color: osColor || "var(--primary)"}}
                    >
                        <OSIcon className="size-6"/>
                    </span>

                    <span className="card-tile-main">
                        <span className="card-tile-title">
                            <span className="card-tile-name">{host.name || host.host}</span>
                        </span>
                        <span className="card-tile-meta">{subtitle}</span>
                    </span>
                </div>
            </ContextMenuPrimitive.Trigger>

            <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.Content className="context-menu-content" collisionPadding={8}>
                    <ContextMenuPrimitive.Item
                        className="context-menu-item"
                        onSelect={() => onConnect(host)}
                    >
                        <Terminal className="size-3.5"/>
                        {t("hosts:connect_now")}
                    </ContextMenuPrimitive.Item>
                    <ContextMenuPrimitive.Item
                        className="context-menu-item"
                        onSelect={() => onEdit(host)}
                    >
                        <Edit className="size-3.5"/>
                        {t("hosts:edit_host")}
                    </ContextMenuPrimitive.Item>
                    <ContextMenuPrimitive.Separator className="context-menu-sep"/>
                    <ContextMenuPrimitive.Item
                        className="context-menu-item is-danger"
                        onSelect={() => onDelete(host)}
                    >
                        <Trash2 className="size-3.5"/>
                        {t("hosts:delete_host")}
                    </ContextMenuPrimitive.Item>
                </ContextMenuPrimitive.Content>
            </ContextMenuPrimitive.Portal>
        </ContextMenuPrimitive.Root>
    );
}
