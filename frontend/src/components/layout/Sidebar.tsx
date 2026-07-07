import { Server, Key, Settings, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore, ViewType } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { SyncStatus } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { useSyncStore } from "@/store/syncStore.ts";
import { useTranslation } from "react-i18next";
import { UpdatePopover } from "@/components/layout/UpdatePopover.tsx";

export function Sidebar() {
    const {t} = useTranslation(["hosts", "keys", "portForwarding", "update", "settings"]);
    const {activeView, setActiveView, isSidebarVisible} = useUIStore();
    const {status} = useSyncStore();

    let dotColor = "bg-muted-foreground";
    if (status === SyncStatus.SyncStatusSyncing) dotColor = "bg-info activity-dot";
    if (status === SyncStatus.SyncStatusSuccess) dotColor = "bg-success";
    if (status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated) dotColor = "bg-destructive";

    const sidebarWidth = (activeView !== ViewType.Terminal || isSidebarVisible) ? "var(--sidebar-width)" : "0px";

    return (
        <aside
            className={cn(
                "wails-drag flex shrink-0 flex-col items-center justify-between " +
                "border-r border-border bg-sidebar pb-4 pt-2 transition-[width] duration-200",
                (activeView !== ViewType.Terminal || isSidebarVisible) ? "overflow-visible" : "overflow-hidden border-r-0"
            )}
            style={{ width: sidebarWidth }}
        >
            <nav className="flex flex-col gap-2">
                <Button
                    variant={activeView === ViewType.Hosts ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() => setActiveView(ViewType.Hosts)}
                    className={cn("wails-no-drag transition-all duration-200", activeView === ViewType.Hosts && "nav-item-active")}
                    title={t("page_title", { ns: "hosts" })}
                >
                    <Server className="size-5"/>
                </Button>

                <Button
                    variant={activeView === ViewType.Keys ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() => setActiveView(ViewType.Keys)}
                    className={cn("wails-no-drag transition-all duration-200", activeView === ViewType.Keys && "nav-item-active")}
                    title={t("page_title", { ns: "keys" })}
                >
                    <Key className="size-5"/>
                </Button>

                <Button
                    variant={activeView === ViewType.PortForwarding ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() => setActiveView(ViewType.PortForwarding)}
                    className={cn("wails-no-drag transition-all duration-200", activeView === ViewType.PortForwarding && "nav-item-active")}
                    title={t("title", { ns: "portForwarding" })}
                >
                    <ArrowRightLeft className="size-5"/>
                </Button>
            </nav>

            <nav className="flex flex-col gap-2">
                <UpdatePopover/>

                <div className="relative">
                    <Button
                        variant={activeView === ViewType.Settings ? "secondary" : "ghost"}
                        size="icon"
                        onClick={() => setActiveView(ViewType.Settings)}
                        className={cn("wails-no-drag text-muted-foreground hover:text-foreground transition-all duration-200", activeView === ViewType.Settings && "nav-item-active")}
                        title={t("page_title", { ns: "settings" })}
                    >
                        <Settings className="size-5"/>
                    </Button>

                    <div className={cn(
                        "absolute right-1 top-1 size-2 rounded-full border border-sidebar",
                        dotColor
                    )}/>
                </div>
            </nav>
        </aside>
    );
}