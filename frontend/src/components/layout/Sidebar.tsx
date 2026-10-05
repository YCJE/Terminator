import { Server, Key, Settings, ArrowRightLeft, type LucideIcon } from "lucide-react";
import { useUIStore, ViewType } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { SyncStatus } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { useSyncStore } from "@/store/syncStore.ts";
import { useTranslation } from "react-i18next";
import { UpdatePopover } from "@/components/layout/UpdatePopover.tsx";

export function Sidebar() {
    const {t} = useTranslation(["hosts", "keys", "portForwarding", "update", "settings"]);
    const {activeView, setActiveView, isSidebarVisible} = useUIStore();
    const {status, conflictCount} = useSyncStore();

    let dotColor = "bg-[var(--fg-subtle)]";
    if (status === SyncStatus.SyncStatusSyncing) dotColor = "bg-info";
    if (status === SyncStatus.SyncStatusSuccess) dotColor = "bg-success";
    if (status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated) dotColor = "bg-destructive";

    // 终端视图下侧栏可折叠，其余视图恒定展开
    const isVisible = activeView !== ViewType.Terminal || isSidebarVisible;

    const navItems: { view: ViewType; icon: LucideIcon; title: string }[] = [
        { view: ViewType.Hosts, icon: Server, title: t("page_title", {ns: "hosts"}) },
        { view: ViewType.Keys, icon: Key, title: t("page_title", {ns: "keys"}) },
        { view: ViewType.PortForwarding, icon: ArrowRightLeft, title: t("title", {ns: "portForwarding"}) },
    ];

    return (
        <aside
            className={cn("shell-sidebar wails-drag", !isVisible && "is-collapsed")}
            style={{ width: isVisible ? "var(--sidebar-width)" : "0px" }}
        >
            <nav className="shell-nav">
                {navItems.map((item) => (
                    <button
                        key={item.view}
                        type="button"
                        onClick={() => setActiveView(item.view)}
                        title={item.title}
                        className={cn("shell-nav-btn wails-no-drag", activeView === item.view && "is-active")}
                    >
                        <item.icon className="size-[18px]"/>
                    </button>
                ))}
            </nav>

            <nav className="shell-nav">
                <UpdatePopover/>

                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setActiveView(ViewType.Settings)}
                        className={cn("shell-nav-btn wails-no-drag", activeView === ViewType.Settings && "is-active")}
                        // 徽标自身设了 pointer-events-none，title 不会触发，
                        // 因此把冲突提示挂到按钮上，悬停时仍能看到数量
                        title={conflictCount > 0
                            ? `${t("page_title", { ns: "settings" })} · ${t("conflict_badge_tooltip", {ns: "settings", count: conflictCount})}`
                            : t("page_title", { ns: "settings" })}
                    >
                        <Settings className="size-[18px]"/>
                    </button>

                    <div className={cn(
                        "absolute right-1 top-1 size-2 rounded-full border border-[var(--sidebar)]",
                        dotColor
                    )}/>

                    {/* 未解决的同步冲突数量；点击设置进入同步分类处理 */}
                    {conflictCount > 0 && (
                        <span
                            aria-label={t("conflict_badge_tooltip", {ns: "settings", count: conflictCount})}
                            className="pointer-events-none absolute -bottom-1 -right-1 flex size-4 items-center
                                       justify-center rounded-full bg-destructive text-[10px] font-medium
                                       leading-none text-destructive-foreground"
                        >
                            {conflictCount > 9 ? "9+" : conflictCount}
                        </span>
                    )}
                </div>
            </nav>
        </aside>
    );
}