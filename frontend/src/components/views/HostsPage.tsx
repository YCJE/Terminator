import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Server, ChevronRight, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HostCard } from "@/components/views/HostCard";
import { HostForm } from "@/components/views/HostForm";
import { PasswordPromptDialog } from "@/components/views/PasswordPromptDialog";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SlidePanel } from "@/components/ui/slide-panel";
import { useHosts, useSaveHost, useDeleteHost } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { useSessionStore } from "@/store/sessionStore";
import { Host } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { cn } from "@/lib/utils";

const UNGROUPED = "__ungrouped__";

export function HostsPage() {
    const {t} = useTranslation(["hosts", "common"]);
    const {data: hosts, isLoading} = useHosts();
    const {data: keys} = useKeys();

    const saveMutation = useSaveHost();
    const deleteMutation = useDeleteHost();
    const {addSession} = useSessionStore();

    const [showForm, setShowForm] = useState(false);
    const [editingHost, setEditingHost] = useState<Host | null>(null);
    const [hostToDelete, setHostToDelete] = useState<Host | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

    // 交互式密码输入状态
    const [passwordPromptHost, setPasswordPromptHost] = useState<Host | null>(null);

    const handleCreateNew = () => {
        setEditingHost(null);
        setShowForm(true);
    };

    const handleEdit = (host: Host) => {
        setEditingHost(host);
        setShowForm(true);
    };

    const handleDeletePrompt = (host: Host) => {
        setHostToDelete(host);
    };

    const handleConfirmDelete = () => {
        if (hostToDelete) deleteMutation.mutate(hostToDelete.id);
        setHostToDelete(null);
    };

    const handleSave = (host: Host) => {
        saveMutation.mutate(host, {onSuccess: () => setShowForm(false)});
    };

    // 实际建立连接（提取公共逻辑）
    const doConnect = useCallback((host: Host, password?: string) => {
        let keyString: string | undefined = undefined;

        if (host.keyId && keys) {
            const foundKey = keys.find(k => k.id === host.keyId);
            if (foundKey) keyString = foundKey.privateKey;
        }

        addSession({
            host: host.host,
            port: host.port,
            username: host.username,
            password: password || host.password,
            privateKey: keyString,
            title: host.name || host.host,
        });
    }, [keys, addSession]);

    // 连接主机：如果没有保存密码且没有密钥，弹出密码输入框
    const handleConnect = useCallback((host: Host) => {
        const hasKey = host.keyId && keys?.some(k => k.id === host.keyId);
        const keyNotLoaded = !!host.keyId && !keys;

        // keys 尚未加载但主机配置了 keyId，不连接（等 keys 加载后重试）
        if (keyNotLoaded) return;

        if (!host.password && !hasKey) {
            // 需要交互式输入密码
            setPasswordPromptHost(host);
        } else {
            doConnect(host);
        }
    }, [keys, doConnect]);

    const handlePasswordConfirm = (password: string) => {
        if (passwordPromptHost) {
            doConnect(passwordPromptHost, password);
        }
        setPasswordPromptHost(null);
    };

    // 搜索过滤 + 分组
    const groupedHosts = useMemo(() => {
        const query = searchQuery.toLowerCase();
        const filtered = hosts?.filter((h) =>
            h.name?.toLowerCase().includes(query) ||
            h.host.toLowerCase().includes(query) ||
            (h.group || "").toLowerCase().includes(query)
        ) || [];

        // 按分组组织
        const groups = new Map<string, Host[]>();
        for (const h of filtered) {
            const g = h.group?.trim() || UNGROUPED;
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push(h);
        }
        // 排序：未分组放最后
        return Array.from(groups.entries()).sort(([a], [b]) => {
            if (a === UNGROUPED) return 1;
            if (b === UNGROUPED) return -1;
            return a.localeCompare(b);
        });
    }, [hosts, searchQuery]);

    const toggleGroup = (group: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
        });
    };

    const hasGroups = groupedHosts.length > 1 || (groupedHosts.length === 1 && groupedHosts[0][0] !== UNGROUPED);

    return (
        <div className="flex h-full w-full overflow-hidden">
        <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-8">
            <div className="mb-8 flex w-full items-center gap-4">
                <h1 className="shrink-0 text-2xl font-bold tracking-tight text-foreground">
                    {t("page_title")}
                </h1>
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                    <Input
                        placeholder={t("search_hosts")}
                        className="w-full border-border bg-input/50 pl-9"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button onClick={handleCreateNew} className="shrink-0">
                    <Plus/>
                    {t("new_host")}
                </Button>
            </div>

            {isLoading && <div className="text-sm text-muted-foreground">{t("loading_hosts")}</div>}

            {!isLoading && hosts?.length === 0 && (
                <div
                    className="soft-card flex flex-col items-center justify-center py-20 text-center
                               rounded-xl">
                    <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Server className="size-6"/>
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">{t("empty_title")}</h3>
                    <p className="mb-4 mt-2 text-sm text-muted-foreground">{t("empty_desc")}</p>
                    <Button variant="outline" onClick={handleCreateNew}>{t("add_first_host")}</Button>
                </div>
            )}

            {/* 主机列表：有分组时按分组展示，无分组时平铺 */}
            {hasGroups ? (
                <div className="flex flex-col gap-6">
                    {groupedHosts.map(([group, groupHosts]) => {
                        const isCollapsed = collapsedGroups.has(group);
                        const groupName = group === UNGROUPED ? t("ungrouped") : group;
                        return (
                            <div key={group}>
                                {/* 分组标题 */}
                                <button
                                    onClick={() => toggleGroup(group)}
                                    className="mb-3 flex w-full items-center gap-2 text-left"
                                >
                                    <ChevronRight
                                        className={cn(
                                            "size-4 text-muted-foreground transition-transform",
                                            !isCollapsed && "rotate-90"
                                        )}
                                    />
                                    {group !== UNGROUPED && (
                                        <FolderOpen className="size-4 text-primary/70" />
                                    )}
                                    <span className="text-sm font-semibold text-foreground">
                                        {groupName}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        ({groupHosts.length})
                                    </span>
                                </button>

                                {/* 分组内的主机卡片 */}
                                {!isCollapsed && (
                                    <div
                                        className="grid w-full gap-4"
                                        style={{gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))"}}
                                    >
                                        {groupHosts.map((host, index) => (
                                            <div key={host.id} className="stagger-in" style={{['--stagger-index' as string]: index}}>
                                                <HostCard
                                                    host={host}
                                                    onConnect={handleConnect}
                                                    onEdit={handleEdit}
                                                    onDelete={handleDeletePrompt}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : groupedHosts.length > 0 ? (
                <div
                    className="grid w-full gap-4"
                    style={{gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))"}}
                >
                    {groupedHosts[0][1].map((host, index) => (
                        <div key={host.id} className="stagger-in" style={{['--stagger-index' as string]: index}}>
                            <HostCard
                                host={host}
                                onConnect={handleConnect}
                                onEdit={handleEdit}
                                onDelete={handleDeletePrompt}
                            />
                        </div>
                    ))}
                </div>
            ) : !isLoading && hosts && hosts.length > 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                    {t("no_search_results")}
                </div>
            ) : null}

            <PasswordPromptDialog
                isOpen={!!passwordPromptHost}
                hostName={passwordPromptHost?.name || passwordPromptHost?.host || ""}
                onClose={() => setPasswordPromptHost(null)}
                onConfirm={handlePasswordConfirm}
            />

            <ConfirmModal
                isOpen={!!hostToDelete}
                onClose={() => setHostToDelete(null)}
                onConfirm={handleConfirmDelete}
                title={t("delete_title")}
                description={t("delete_desc", {name: hostToDelete?.name || hostToDelete?.host})}
                confirmText={t("delete", {ns: "common"})}
                isDestructive={true}
            />
        </div>

            <SlidePanel
                open={showForm}
                onClose={() => setShowForm(false)}
                title={editingHost ? t("edit_title") : t("new_title")}
                width={400}
            >
                <HostForm
                    initialData={editingHost}
                    isSaving={saveMutation.isPending}
                    onSave={handleSave}
                    onCancel={() => setShowForm(false)}
                />
            </SlidePanel>
        </div>
    );
}
