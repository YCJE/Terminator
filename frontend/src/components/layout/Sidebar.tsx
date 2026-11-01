import { useState } from "react";
import { Server, Key, Settings, ArrowRightLeft, Zap, ShieldCheck, Layers, Cable, type LucideIcon } from "lucide-react";
import { useUIStore, ViewType } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { TelnetSerialDialog } from "@/components/views/TelnetSerialDialog";
import { SyncStatus } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { useSyncStore } from "@/store/syncStore.ts";
import { useTranslation } from "react-i18next";
import { UpdatePopover } from "@/components/layout/UpdatePopover.tsx";

/**
 * 左侧导航栏
 * ------------------------------------------------------------
 * 结构参考 Termius：逻辑分组（工作区 / 工具）+ 底部状态卡。
 * 交互只做导航与快速连接；同步/冲突状态集中在底部卡片上，
 * 让"系统是否健康"这一信息不散落在多个徽标里。
 */
export function Sidebar() {
    const {t} = useTranslation(["hosts", "keys", "portForwarding", "update", "settings", "common", "batchExec", "terminal"]);
    const {activeView, setActiveView, isSidebarVisible} = useUIStore();
    const setQuickConnectOpen = useUIStore((s) => s.setQuickConnectOpen);
    const openSettingsSection = useUIStore((s) => s.openSettingsSection);
    const {status, conflictCount} = useSyncStore();
    // Telnet / 串口会话不保存为主机，直接弹出一次性连接对话框
    const [netConnOpen, setNetConnOpen] = useState(false);

    // 同步状态 → 文案与颜色：卡片副标题只显示一行，冲突优先
    const syncLabel = status === SyncStatus.SyncStatusSyncing
        ? t("sync_syncing", {ns: "common"})
        : status === SyncStatus.SyncStatusSuccess
            ? t("sync_synced", {ns: "common"})
            : status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated
                ? t("sync_failed", {ns: "common"})
                : t("sync_idle", {ns: "common"});
    const syncTone = status === SyncStatus.SyncStatusSyncing
        ? "is-info"
        : status === SyncStatus.SyncStatusSuccess
            ? "is-success"
            : status === SyncStatus.SyncStatusError || status === SyncStatus.SyncStatusUnauthenticated
                ? "is-error"
                : "is-idle";
    const statusSub = conflictCount > 0
        ? t("conflict_pending", {ns: "common", count: conflictCount})
        : syncLabel;

    // 终端视图下侧栏可折叠；设置页有自己的分类导航，主侧栏让位给内容区
    const isTerminalView = activeView === ViewType.Terminal;
    const isVisible = isTerminalView
        ? isSidebarVisible
        : activeView !== ViewType.Settings;

    const navItems: { view: ViewType; icon: LucideIcon; title: string }[] = [
        { view: ViewType.Hosts, icon: Server, title: t("page_title", {ns: "hosts"}) },
        { view: ViewType.Keys, icon: Key, title: t("page_title", {ns: "keys"}) },
        { view: ViewType.PortForwarding, icon: ArrowRightLeft, title: t("title", {ns: "portForwarding"}) },
    ];

    return (
        <>
        <aside
            // 不设宽度过渡：侧栏"显示/隐藏"同时伴随标题栏品牌区与内容区重排，
            // 只给侧栏做动画会让两条竖线在 180ms 内分开再合上（设置页切换尤其明显）。
            className={cn("shell-sidebar wails-drag", !isVisible && "is-collapsed")}
            style={{ width: isVisible ? "var(--sidebar-width)" : "0px" }}
            // 收起后只是宽度为 0，内部按钮仍可获得键盘焦点；inert 让隐藏侧栏
            // 彻底退出交互与可访问性树，避免 Tab 落到看不见的控件上
            inert={!isVisible}
        >
            <div className="flex min-h-0 flex-col overflow-y-auto overflow-x-hidden">
                <div className="shell-section-label">{t("nav_workspace", {ns: "common"})}</div>
                <nav className="shell-nav">
                    {navItems.map((item) => (
                        <button
                            key={item.view}
                            type="button"
                            onClick={() => setActiveView(item.view)}
                            title={item.title}
                            className={cn("shell-nav-btn wails-no-drag", activeView === item.view && "is-active")}
                        >
                            <item.icon className="size-[16px] shrink-0"/>
                            <span className="shell-nav-label">{item.title}</span>
                        </button>
                    ))}
                </nav>

                <div className="shell-section-label">{t("nav_tools", {ns: "common"})}</div>
                <nav className="shell-nav">
                    {/* 快速连接：不保存主机，直接输入地址与凭据 */}
                    <button
                        type="button"
                        onClick={() => setQuickConnectOpen(true)}
                        title={t("quick_connect_title", {ns: "hosts"})}
                        className="shell-nav-btn wails-no-drag"
                    >
                        <Zap className="size-[16px] shrink-0"/>
                        <span className="shell-nav-label">{t("quick_connect_title", {ns: "hosts"})}</span>
                    </button>
                    {/* Telnet / 串口：面向网络设备与本地硬件的一次性连接 */}
                    <button
                        type="button"
                        onClick={() => setNetConnOpen(true)}
                        title={t("netconn_title", {ns: "terminal"})}
                        className="shell-nav-btn wails-no-drag"
                    >
                        <Cable className="size-[16px] shrink-0"/>
                        <span className="shell-nav-label">{t("netconn_title", {ns: "terminal"})}</span>
                    </button>
                    {/* 批量执行：在多台已连接服务器上跑同一条命令 */}
                    <button
                        type="button"
                        onClick={() => setActiveView(ViewType.BatchExec)}
                        title={t("nav_title", {ns: "batchExec"})}
                        className={cn("shell-nav-btn wails-no-drag", activeView === ViewType.BatchExec && "is-active")}
                    >
                        <Layers className="size-[16px] shrink-0"/>
                        <span className="shell-nav-label">{t("nav_title", {ns: "batchExec"})}</span>
                    </button>
                </nav>
            </div>

            <div className="shell-rail-foot">
                <UpdatePopover/>

                <button
                    type="button"
                    onClick={() => setActiveView(ViewType.Settings)}
                    className={cn("shell-nav-btn wails-no-drag", activeView === ViewType.Settings && "is-active")}
                    title={t("page_title", { ns: "settings" })}
                >
                    <Settings className="size-[16px] shrink-0"/>
                    <span className="shell-nav-label">{t("page_title", { ns: "settings" })}</span>
                </button>

                {/* 状态卡：保险库是否解锁 + 同步健康度；点击直达同步设置 */}
                <button
                    type="button"
                    onClick={() => openSettingsSection("sync")}
                    className="shell-status-card wails-no-drag text-left transition-colors hover:border-[var(--hairline-strong)]"
                    title={conflictCount > 0
                        ? t("conflict_badge_tooltip", {ns: "settings", count: conflictCount})
                        : syncLabel}
                >
                    <ShieldCheck className="size-4 shrink-0 text-[var(--fg-muted)]"/>
                    <span className="shell-status-text">
                        <span className="shell-status-title">{t("vault_unlocked", {ns: "common"})}</span>
                        <span className="shell-status-sub flex items-center gap-1.5">
                            <span className={cn("shell-status-dot", syncTone)}/>
                            {statusSub}
                        </span>
                    </span>
                </button>
            </div>
        </aside>
        <TelnetSerialDialog isOpen={netConnOpen} onClose={() => setNetConnOpen(false)}/>
        </>
    );
}
