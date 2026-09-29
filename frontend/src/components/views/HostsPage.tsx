import { useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Server, ChevronRight, FolderOpen, Download, Upload } from "lucide-react";
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
import { HostService, Host, ItemType, SavedKey } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { JumpHostConfig } from "../../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const UNGROUPED = "__ungrouped__";

// 无名主机的展示名回退规则。导出与导入必须使用同一规则，
// 否则导入时 jumpHostName 匹配不到目标主机，跳板关联会被静默丢弃。
function fallbackHostName(username: string, host: string): string {
    return `${username}@${host}`;
}

// 导入的主机端口做规范化：只接受 1-65535 的整数，其余回退到 22。
// 导入文件可能被手工编辑过，非法端口会让连接时报出难以理解的错误。
function normalizePort(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 22;
    return n;
}

// 递归解析跳板机链：返回最外层跳板机配置，其 jumpHost 字段嵌套下一级跳板。
// visited 记录已访问的 host id，避免 A→B→A 这类循环引用导致无限递归。
function resolveJumpHostChain(
    host: Host,
    hosts: Host[],
    keys: SavedKey[] | undefined,
    visited: Set<string> = new Set(),
): JumpHostConfig | undefined {
    if (!host.jumpHostId || visited.has(host.id)) return undefined;

    const jh = hosts.find((h) => h.id === host.jumpHostId);
    // 自引用或链上已出现过该主机时终止，避免死循环
    if (!jh || visited.has(jh.id)) return undefined;

    visited.add(host.id);
    visited.add(jh.id);

    let jhKey: string | undefined = undefined;
    if (jh.keyId && keys) {
        const foundJhKey = keys.find((k) => k.id === jh.keyId);
        if (foundJhKey) jhKey = foundJhKey.privateKey;
    }

    return new JumpHostConfig({
        host: jh.host,
        port: jh.port,
        username: jh.username,
        password: jh.password || undefined,
        privateKey: jhKey,
        jumpHost: resolveJumpHostChain(jh, hosts, keys, visited),
    });
}

export function HostsPage() {
    const {t} = useTranslation(["hosts", "common"]);
    const {data: hosts, isLoading} = useHosts();
    const {data: keys} = useKeys();

    const saveMutation = useSaveHost();
    const deleteMutation = useDeleteHost();
    const {addSession} = useSessionStore();
    const queryClient = useQueryClient();

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

    // 导入/导出主机配置
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleExport = async () => {
        try {
            const allHosts = await HostService.GetAll();
            // 导出时清除 ID 和敏感字段（密码/代理密码），导入时重新生成
            // 跳板机以「名称」导出：ID 在导入时会重新生成，无法跨 vault 直接引用
            const idToName = new Map(allHosts.map(h => [h.id, h.name || fallbackHostName(h.username, h.host)]));
            const exportData = allHosts.map(h => ({
                name: h.name,
                group: h.group || "",
                host: h.host,
                port: h.port,
                username: h.username,
                jumpHostName: h.jumpHostId ? (idToName.get(h.jumpHostId) || "") : "",
                proxyType: h.proxyType || "",
                proxyHost: h.proxyHost || "",
                proxyPort: h.proxyPort || 0,
                proxyUsername: h.proxyUsername || "",
                agentForwarding: h.agentForwarding || false,
            }));
            const json = JSON.stringify(exportData, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `terminator-hosts-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            // 延迟撤销对象 URL：立即 revoke 在部分浏览器/WebView 中会中断尚未开始的下载
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast.success(t("export_success", { count: exportData.length }));
        } catch {
            toast.error(t("export_failed"));
        }
    };

    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!Array.isArray(data)) throw new Error("invalid format");
            // 第一遍：保存所有主机（跳板机关联留空），记录新 ID 与名称
            const imported: { id: string; name: string; jumpHostName: string; base: Record<string, unknown> }[] = [];
            for (const item of data) {
                if (!item.host || !item.username) continue;
                const name = item.name || fallbackHostName(item.username, item.host);
                const base = {
                    type: ItemType.TypeHost,
                    name,
                    group: item.group || "",
                    host: item.host,
                    port: normalizePort(item.port),
                    username: item.username,
                    password: "",
                    keyId: "",
                    proxyType: item.proxyType || undefined,
                    proxyHost: item.proxyHost || undefined,
                    proxyPort: item.proxyPort || undefined,
                    proxyUsername: item.proxyUsername || undefined,
                    agentForwarding: item.agentForwarding || false,
                };
                const newId = await HostService.Save({ ...base, id: "" } as unknown as Host);
                imported.push({ id: newId, name, jumpHostName: item.jumpHostName || "", base });
            }
            // 第二遍：按名称解析跳板机并写回关联（ID 已重新生成，需映射到新 ID）
            const nameToId = new Map<string, string>();
            imported.forEach((h) => { if (!nameToId.has(h.name)) nameToId.set(h.name, h.id); });
            for (const h of imported) {
                if (!h.jumpHostName) continue;
                const jumpId = nameToId.get(h.jumpHostName);
                if (!jumpId || jumpId === h.id) continue;
                await HostService.Save({ ...h.base, id: h.id, jumpHostId: jumpId } as unknown as Host);
            }
            toast.success(t("import_success", { count: imported.length }));
        } catch {
            toast.error(t("import_failed"));
        } finally {
            // 无论成功还是部分失败，都刷新主机列表以显示已导入的数据
            queryClient.invalidateQueries({ queryKey: ["hosts"] });
        }
        e.target.value = ""; // 重置 input 以便重复导入同一文件
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
        saveMutation.mutate(host, {onSuccess: () => { setShowForm(false); setEditingHost(null); }});
    };

    // 实际建立连接（提取公共逻辑）
    const doConnect = useCallback((host: Host, password?: string) => {
        let keyString: string | undefined = undefined;

        if (host.keyId && keys) {
            const foundKey = keys.find(k => k.id === host.keyId);
            if (foundKey) keyString = foundKey.privateKey;
        }

        // 解析跳板机配置：按 jumpHostId 递归展开整条跳板链并复用各主机的地址与凭据
        const jumpHost = hosts ? resolveJumpHostChain(host, hosts, keys) : undefined;

        addSession({
            host: host.host,
            port: host.port,
            username: host.username,
            password: password || host.password,
            privateKey: keyString,
            title: host.name || host.host,
            jumpHost,
            proxyType: host.proxyType,
            proxyHost: host.proxyHost,
            proxyPort: host.proxyPort,
            proxyUsername: host.proxyUsername,
            proxyPassword: host.proxyPassword,
            agentForwarding: host.agentForwarding,
        });
    }, [keys, hosts, addSession]);

    // 连接主机：如果没有保存密码且没有密钥，弹出密码输入框
    const handleConnect = useCallback((host: Host) => {
        const hasKey = host.keyId && keys?.some(k => k.id === host.keyId);
        const keyNotLoaded = !!host.keyId && !keys;

        // keys 尚未加载但主机配置了 keyId：此时连接会因缺少私钥而失败。
        // 必须给出提示，否则用户点击后毫无反应
        if (keyNotLoaded) {
            toast.error(t("keys_not_loaded"));
            return;
        }

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
                <Button variant="outline" onClick={handleImportClick} className="shrink-0" title={t("import_hosts")}>
                    <Upload/>
                </Button>
                <Button variant="outline" onClick={handleExport} className="shrink-0" title={t("export_hosts")}>
                    <Download/>
                </Button>
                <Button onClick={handleCreateNew} className="shrink-0">
                    <Plus/>
                    {t("new_host")}
                </Button>
            </div>
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden" />

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
