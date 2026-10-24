import { useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Server, ChevronRight, Download, Upload, FileCode2 } from "lucide-react";
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
import { HostService, Host, ItemType, SSHConfigHost } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { buildSessionParams, fallbackHostName } from "@/lib/hostConnection";
import { parseAppError } from "@/lib/error";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const UNGROUPED = "__ungrouped__";

// 导入的主机端口做规范化：只接受 1-65535 的整数，其余回退到 22。
// 导入文件可能被手工编辑过，非法端口会让连接时报出难以理解的错误。
function normalizePort(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 22;
    return n;
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

    // ~/.ssh/config 导入候选：确认弹窗展示条数与别名，确认后批量落库
    const [sshConfigCandidates, setSshConfigCandidates] = useState<SSHConfigHost[] | null>(null);
    const [isImportingSSHConfig, setIsImportingSSHConfig] = useState(false);

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
                onConnect: h.onConnect || "",
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
                    onConnect: typeof item.onConnect === "string" ? item.onConnect : undefined,
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

    // 解析 ~/.ssh/config，先展示候选再落库，避免直接写入大量主机
    const handleSSHConfigImportClick = async () => {
        try {
            const parsed = await HostService.ParseSSHConfig();
            if (!parsed || parsed.length === 0) {
                toast.error(t("ssh_config_empty"));
                return;
            }
            setSshConfigCandidates(parsed);
        } catch (err) {
            console.error("解析 ~/.ssh/config 失败:", err);
            // 配置文件不存在与解析失败分开提示：前者属于正常情况，用户只需自行创建
            const message = parseAppError(err).message;
            toast.error(message.includes("未找到") ? t("ssh_config_empty") : t("ssh_config_parse_failed"));
        }
    };

    const handleConfirmSSHConfigImport = async () => {
        const candidates = sshConfigCandidates;
        setSshConfigCandidates(null);
        if (!candidates) return;

        setIsImportingSSHConfig(true);
        try {
            const existing = hosts ?? [];
            // 名称去重：SSH config 的 Host 别名即主机名，重复导入同一别名视为已存在
            const existingNames = new Set(
                existing.map((h) => h.name || fallbackHostName(h.username, h.host))
            );
            const existingEndpoints = new Set(
                existing.map((h) => `${h.username}@${h.host}:${h.port}`)
            );

            const created: { id: string; alias: string; proxyJump: string; base: Record<string, unknown> }[] = [];
            for (const item of candidates) {
                const username = item.username || "";
                const endpoint = `${username}@${item.host}:${item.port}`;
                if (existingNames.has(item.alias) || existingEndpoints.has(endpoint)) continue;

                const base = {
                    type: ItemType.TypeHost,
                    name: item.alias,
                    group: "",
                    host: item.host,
                    port: normalizePort(item.port),
                    username,
                    password: "",
                    keyId: "",
                };
                const newId = await HostService.Save({ ...base, id: "" } as unknown as Host);
                created.push({ id: newId, alias: item.alias, proxyJump: item.proxyJump || "", base });
                // 把刚保存的主机同步进去重集合：后续条目若与其同别名/同端点应跳过，
                // 否则同一 user@host:port 的不同别名会被重复导入。
                existingNames.add(item.alias);
                existingEndpoints.add(endpoint);
            }

            // 第二遍：把 ProxyJump 别名映射到新建主机或已有主机的 ID
            const nameToId = new Map<string, string>();
            existing.forEach((h) => {
                const name = h.name || fallbackHostName(h.username, h.host);
                if (!nameToId.has(name)) nameToId.set(name, h.id);
            });
            created.forEach((h) => nameToId.set(h.alias, h.id));
            for (const h of created) {
                if (!h.proxyJump) continue;
                // ProxyJump 支持 user@host:port 与逗号分隔多跳；这里只取第一跳
                const firstHop = h.proxyJump.split(",")[0]?.trim() || "";
                const alias = firstHop.replace(/^.*@/, "").replace(/:\d+$/, "");
                const jumpId = nameToId.get(alias);
                if (!jumpId || jumpId === h.id) continue;
                await HostService.Save({ ...h.base, id: h.id, jumpHostId: jumpId } as unknown as Host);
            }

            const skipped = candidates.length - created.length;
            toast.success(t("ssh_config_import_success", { count: created.length, skipped }));
        } catch (err) {
            console.error("导入 ~/.ssh/config 失败:", err);
            toast.error(t("ssh_config_import_failed"));
        } finally {
            queryClient.invalidateQueries({ queryKey: ["hosts"] });
            setIsImportingSSHConfig(false);
        }
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

    // 实际建立连接（提取公共逻辑，与命令面板共用 hostConnection 的参数构建）
    const doConnect = useCallback((host: Host, password?: string) => {
        addSession(buildSessionParams(host, hosts, keys, password));
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
        <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {/* 工具条：标题 + 计数 + 搜索 + 操作 */}
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--hairline)] px-6 pt-4 pb-3">
                <h1 className="shrink-0 text-base font-semibold tracking-tight text-[var(--fg-strong)]">
                    {t("page_title")}
                </h1>
                <span className="shrink-0 rounded-[5px] border border-[var(--hairline)] bg-[var(--surface-2)]
                                 px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--fg-subtle)]">
                    {hosts?.length ?? 0}
                </span>
                <div className="flex-1"/>
                <div className="relative w-64 min-w-0 shrink">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                    <Input
                        placeholder={t("search_hosts")}
                        className="h-[var(--control-height)] w-full border-[var(--hairline)]
                                   bg-[var(--surface-0)] pl-8 text-[12.5px]"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button variant="outline" onClick={handleSSHConfigImportClick}
                        className="h-[var(--control-height)] shrink-0 px-2.5" title={t("ssh_config_import")}>
                    <FileCode2/>
                </Button>
                <Button variant="outline" onClick={handleImportClick}
                        className="h-[var(--control-height)] shrink-0 px-2.5" title={t("import_hosts")}>
                    <Upload/>
                </Button>
                <Button variant="outline" onClick={handleExport}
                        className="h-[var(--control-height)] shrink-0 px-2.5" title={t("export_hosts")}>
                    <Download/>
                </Button>
                <Button onClick={handleCreateNew} className="h-[var(--control-height)] shrink-0">
                    <Plus/>
                    {t("new_host")}
                </Button>
            </div>
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden"/>

            {/* 列表：分组 + 紧凑行 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {isLoading && <div className="px-2 py-4 text-sm text-[var(--fg-muted)]">{t("loading_hosts")}</div>}

                {!isLoading && hosts?.length === 0 && (
                    <div
                        className="soft-card mt-4 flex flex-col items-center justify-center py-20 text-center
                                   rounded-xl">
                        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Server className="size-6"/>
                        </div>
                        <h3 className="text-lg font-semibold text-[var(--fg-strong)]">{t("empty_title")}</h3>
                        <p className="mb-4 mt-2 text-sm text-[var(--fg-muted)]">{t("empty_desc")}</p>
                        <Button variant="outline" onClick={handleCreateNew}>{t("add_first_host")}</Button>
                    </div>
                )}

                {/* 主机列表：有分组时按分组展示，无分组时平铺 */}
                {hasGroups ? (
                    <div className="flex flex-col">
                        {groupedHosts.map(([group, groupHosts]) => {
                            const isCollapsed = collapsedGroups.has(group);
                            const groupName = group === UNGROUPED ? t("ungrouped") : group;
                            return (
                                <div key={group} className="mt-5">
                                    {/* 分组标题 */}
                                    <button
                                        onClick={() => toggleGroup(group)}
                                        className="sticky top-0 z-[2] flex h-[30px] w-full items-center gap-2
                                                   border-b border-[var(--hairline)] bg-[var(--surface-0)] px-2 text-left"
                                    >
                                        <ChevronRight
                                            className={cn(
                                                "size-3.5 text-[var(--fg-subtle)] transition-transform",
                                                !isCollapsed && "rotate-90"
                                            )}
                                        />
                                        <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--fg-muted)]">
                                            {groupName}
                                        </span>
                                        <span className="font-mono text-[11px] text-[var(--fg-subtle)]">
                                            {groupHosts.length}
                                        </span>
                                        <span className="h-px flex-1 bg-[var(--hairline)]"/>
                                    </button>

                                    {/* 分组内的主机行 */}
                                    {!isCollapsed && (
                                        <div className="list-rows">
                                            {groupHosts.map((host) => (
                                                <HostCard
                                                    key={host.id}
                                                    host={host}
                                                    onConnect={handleConnect}
                                                    onEdit={handleEdit}
                                                    onDelete={handleDeletePrompt}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : groupedHosts.length > 0 ? (
                    <div className="list-rows mt-2">
                        {groupedHosts[0][1].map((host) => (
                            <HostCard
                                key={host.id}
                                host={host}
                                onConnect={handleConnect}
                                onEdit={handleEdit}
                                onDelete={handleDeletePrompt}
                            />
                        ))}
                    </div>
                ) : !isLoading && hosts && hosts.length > 0 ? (
                    <div className="py-12 text-center text-sm text-[var(--fg-muted)]">
                        {t("no_search_results")}
                    </div>
                ) : null}
            </div>

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

            <ConfirmModal
                isOpen={!!sshConfigCandidates}
                onClose={() => setSshConfigCandidates(null)}
                onConfirm={handleConfirmSSHConfigImport}
                title={t("ssh_config_import_title")}
                description={t("ssh_config_import_desc", {
                    count: sshConfigCandidates?.length ?? 0,
                    names: (sshConfigCandidates ?? []).slice(0, 20).map((h) => h.alias).join(", "),
                })}
                confirmText={isImportingSSHConfig ? t("ssh_config_importing") : t("ssh_config_import")}
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
