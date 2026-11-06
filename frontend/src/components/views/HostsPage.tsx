import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
    Plus,
    Server,
    Download,
    Upload,
    FileCode2,
    ChevronDown,
    SquareTerminal,
    LayoutGrid,
    MoreHorizontal,
    Trash2,
    Clock3,
    Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostCard } from "@/components/views/HostCard";
import { HostForm, HOST_FORM_ID } from "@/components/views/HostForm";
import { PasswordPromptDialog } from "@/components/views/PasswordPromptDialog";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SlidePanel } from "@/components/ui/slide-panel";
import { useHosts, useSaveHost, useDeleteHost } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { useSessionStore } from "@/store/sessionStore";
import { HostService, Host, ItemType, SSHConfigHost } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { SettingsService, type RecentHost } from "../../../bindings/terminator-desktop/backend/internal/services/settings";
import { buildSessionParams, fallbackHostName } from "@/lib/hostConnection";
import { normalizeTerminalEncoding } from "@/lib/terminalEncoding";
import { parseAppError } from "@/lib/error";
import { cn } from "@/lib/utils";
import type React from "react";
import { toast } from "sonner";

// 导入的主机端口做规范化：只接受 1-65535 的整数，其余回退到 22。
// 导入文件可能被手工编辑过，非法端口会让连接时报出难以理解的错误。
function normalizePort(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 22;
    return n;
}

// 可选端口（如代理端口）：非法/缺失时返回 undefined，由调用方决定是否跳过该配置。
function optionalPort(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
    return n;
}

// 导入文件的字段可能被手工编辑过：只接受字符串并去掉首尾空白，
// 其他类型（数字、对象）一律视为未填写，避免它们被 JSON 序列化进主机配置。
function importString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 导入的整数参数做范围校验，非法值视为未设置（使用默认行为）。
function importInt(value: unknown, min: number, max: number): number | undefined {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return undefined;
    return n;
}

// 代理配置按类型收敛：类型/地址/端口任一无效就整体丢弃，
// 避免导入出一台"看起来有代理、实际连不上"的主机。
function importProxy(item: Record<string, unknown>): Record<string, unknown> {
    const rawType = importString(item.proxyType)?.toLowerCase();
    if (rawType !== "http" && rawType !== "socks5") return {};
    const host = importString(item.proxyHost);
    const port = optionalPort(item.proxyPort);
    if (!host || !port) return {};
    return {
        proxyType: rawType,
        proxyHost: host,
        proxyPort: port,
        proxyUsername: importString(item.proxyUsername),
    };
}

export function HostsPage() {
    const {t} = useTranslation(["hosts", "common"]);
    const {data: hosts, isLoading} = useHosts();
    const {data: keys} = useKeys();

    const saveMutation = useSaveHost();
    const deleteMutation = useDeleteHost();
    const {addSession, addLocalSession} = useSessionStore();
    const queryClient = useQueryClient();

    const [panelOpen, setPanelOpen] = useState(false);
    const [editingHost, setEditingHost] = useState<Host | null>(null);
    const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
    const [hostToDelete, setHostToDelete] = useState<Host | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

    // 交互式密码输入状态
    const [passwordPromptHost, setPasswordPromptHost] = useState<Host | null>(null);

    // 最近连接记录（本地文件，不参与同步）
    const [recentHosts, setRecentHosts] = useState<RecentHost[]>([]);
    const loadRecentHosts = useCallback(() => {
        SettingsService.GetRecentHosts()
            .then((list) => setRecentHosts(Array.isArray(list) ? list : []))
            .catch(() => setRecentHosts([]));
    }, []);
    useEffect(() => {
        loadRecentHosts();
    }, [loadRecentHosts]);

    // ~/.ssh/config 导入候选：确认弹窗展示条数与别名，确认后批量落库
    const [sshConfigCandidates, setSshConfigCandidates] = useState<SSHConfigHost[] | null>(null);
    const [isImportingSSHConfig, setIsImportingSSHConfig] = useState(false);

    const handleCreateNew = () => {
        setEditingHost(null);
        setSelectedHostId(null);
        setPanelOpen(true);
    };

    const closePanel = () => {
        setPanelOpen(false);
        setEditingHost(null);
        setSelectedHostId(null);
    };

    // 单击卡片：选中并在右侧详情面板中编辑（Termius 交互）
    const handleSelect = (host: Host) => {
        setEditingHost(host);
        setSelectedHostId(host.id);
        setPanelOpen(true);
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
                keyboardInteractive: h.keyboardInteractive || false,
                onConnect: h.onConnect || "",
                // 会话高级参数：缺失时导入会退回默认值，导出的主机行为与原来不一致
                termType: h.termType || "",
                encoding: h.encoding || "",
                connectTimeout: h.connectTimeout || 0,
                keepAlive: h.keepAlive || 0,
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

            // 以库中现有主机为基准：
            // 1) 跳板机名称映射可指向已存在的主机，而不是只看本次文件；
            // 2) 按「名称 + 端点」去重，重复导入同一文件不会产生多份相同主机。
            const existing = (await HostService.GetAll()) ?? [];
            const nameToId = new Map<string, string>();
            const existingKeys = new Set<string>();
            existing.forEach((h) => {
                const name = h.name || fallbackHostName(h.username, h.host);
                if (!nameToId.has(name)) nameToId.set(name, h.id);
                existingKeys.add(`${name}\u0000${h.username}@${h.host}:${h.port}`);
            });

            // 第一遍：保存所有主机（跳板机关联留空），记录新 ID 与名称
            const imported: { id: string; name: string; jumpHostName: string; base: Record<string, unknown> }[] = [];
            let skipped = 0;
            for (const raw of data) {
                const item = (raw ?? {}) as Record<string, unknown>;
                const host = importString(item.host);
                const username = importString(item.username);
                if (!host || !username) {
                    skipped++;
                    continue;
                }
                const name = importString(item.name) || fallbackHostName(username, host);
                const port = normalizePort(item.port);
                const dedupeKey = `${name}\u0000${username}@${host}:${port}`;
                if (existingKeys.has(dedupeKey)) {
                    skipped++;
                    continue;
                }
                const encoding = normalizeTerminalEncoding(importString(item.encoding));
                const base = {
                    type: ItemType.TypeHost,
                    name,
                    group: importString(item.group) || "",
                    host,
                    port,
                    username,
                    password: "",
                    keyId: "",
                    agentForwarding: item.agentForwarding === true,
                    keyboardInteractive: item.keyboardInteractive === true,
                    onConnect: importString(item.onConnect),
                    // 终端高级参数：缺失/非法时落回后端默认值
                    termType: importString(item.termType),
                    encoding: encoding === "utf-8" ? undefined : encoding,
                    connectTimeout: importInt(item.connectTimeout, 0, 120),
                    keepAlive: importInt(item.keepAlive, -1, 300),
                    ...importProxy(item),
                };
                const newId = await HostService.Save({ ...base, id: "" } as unknown as Host);
                existingKeys.add(dedupeKey);
                // 本次文件中的条目优先作为跳板目标：同名主机以导入后的新 ID 为准
                nameToId.set(name, newId);
                imported.push({
                    id: newId,
                    name,
                    jumpHostName: importString(item.jumpHostName) || "",
                    base,
                });
            }
            // 第二遍：按名称解析跳板机并写回关联（ID 已重新生成，需映射到新 ID）
            for (const h of imported) {
                if (!h.jumpHostName) continue;
                const jumpId = nameToId.get(h.jumpHostName);
                if (!jumpId || jumpId === h.id) continue;
                await HostService.Save({ ...h.base, id: h.id, jumpHostId: jumpId } as unknown as Host);
            }
            // 有跳过项时用带 skipped 的文案，让用户知道并非全部写入
            if (skipped > 0) {
                toast.success(t("ssh_config_import_success", { count: imported.length, skipped }));
            } else {
                toast.success(t("import_success", { count: imported.length }));
            }
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
        setSelectedHostId(host.id);
        setPanelOpen(true);
    };

    const handleDeletePrompt = (host: Host) => {
        setHostToDelete(host);
    };

    const handleConfirmDelete = () => {
        if (hostToDelete) {
            deleteMutation.mutate(hostToDelete.id);
            if (selectedHostId === hostToDelete.id) closePanel();
        }
        setHostToDelete(null);
    };

    const handleSave = (host: Host) => {
        saveMutation.mutate(host, {onSuccess: closePanel});
    };

    // 实际建立连接（提取公共逻辑，与命令面板共用 hostConnection 的参数构建）
    const doConnect = useCallback((host: Host, password?: string) => {
        addSession(buildSessionParams(host, hosts, keys, password));
        // 连接后立即刷新最近记录，返回主机列表时无需重新进入页面
        loadRecentHosts();
    }, [keys, hosts, addSession, loadRecentHosts]);

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

    // 分组卡片：按分组聚合主机数量（Termius 的 Groups 区）
    const groupEntries = useMemo(() => {
        const counts = new Map<string, number>();
        for (const h of hosts ?? []) {
            const g = h.group?.trim();
            if (!g) continue;
            counts.set(g, (counts.get(g) || 0) + 1);
        }
        return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [hosts]);

    // 搜索 + 分组筛选后的主机列表
    const visibleHosts = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return (hosts ?? [])
            .filter((h) => !selectedGroup || (h.group?.trim() || "") === selectedGroup)
            .filter((h) =>
                h.name?.toLowerCase().includes(query) ||
                h.host.toLowerCase().includes(query) ||
                (h.group || "").toLowerCase().includes(query))
            .sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host));
    }, [hosts, searchQuery, selectedGroup]);

    const selectedHost = useMemo(
        () => (hosts ?? []).find((h) => h.id === selectedHostId) ?? null,
        [hosts, selectedHostId]
    );

    // 最近连接：只展示仍然存在的主机（主机被删后本地记录会残留）
    const recentHostEntries = useMemo(() => {
        const byId = new Map((hosts ?? []).map((h) => [h.id, h]));
        const out: Host[] = [];
        for (const item of recentHosts) {
            const host = byId.get(item.host_id);
            if (host) out.push(host);
            if (out.length >= 6) break;
        }
        return out;
    }, [hosts, recentHosts]);

    return (
        <div className="flex h-full w-full overflow-hidden">
            <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
                {/* 搜索行：全宽搜索 + 右侧 Connect（Termius 结构） */}
                <div className="page-header">
                    <div className="search-field">
                        <Search className="pointer-events-none absolute left-3.5 size-4 text-[var(--fg-subtle)]"/>
                        <Input
                            placeholder={t("search_hosts")}
                            aria-label={t("search_hosts")}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <button
                            type="button"
                            className="search-action"
                            disabled={!selectedHost}
                            onClick={() => selectedHost && handleConnect(selectedHost)}
                        >
                            {t("connect_now")}
                        </button>
                    </div>

                    {/* 工具栏：新建主机（含下拉）/ 终端 */}
                    <div className="toolbar-row">
                        <div className="split-btn">
                            <button type="button" className="split-btn-main" onClick={handleCreateNew}>
                                <Plus className="size-4"/>
                                {t("new_host")}
                            </button>
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        className="split-btn-caret"
                                        aria-label={t("new_host")}
                                    >
                                        <ChevronDown className="size-3.5"/>
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="w-52">
                                    <DropdownMenuItem onClick={handleCreateNew}>
                                        <Plus className="mr-2 size-4"/>
                                        {t("new_host")}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator/>
                                    <DropdownMenuItem onClick={handleImportClick}>
                                        <Upload className="mr-2 size-4"/>
                                        {t("import_hosts")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={handleExport}>
                                        <Download className="mr-2 size-4"/>
                                        {t("export_hosts")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={handleSSHConfigImportClick}>
                                        <FileCode2 className="mr-2 size-4"/>
                                        {t("ssh_config_import")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>

                        <button type="button" className="toolbar-btn" onClick={() => addLocalSession()}>
                            <SquareTerminal className="size-4"/>
                            {t("local_terminal")}
                        </button>
                    </div>
                </div>
                <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden"/>

                {/* 列表：Groups 分组卡片 + Hosts 主机卡片 */}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
                    {isLoading && <div className="py-4 text-sm text-[var(--fg-muted)]">{t("loading_hosts")}</div>}

                    {!isLoading && hosts?.length === 0 && (
                        <div className="empty-state">
                            <span className="empty-state-icon">
                                <Server className="size-5"/>
                            </span>
                            <h3 className="empty-state-title">{t("empty_title")}</h3>
                            <p className="empty-state-desc">{t("empty_desc")}</p>
                            <Button variant="outline" className="mt-4" onClick={handleCreateNew}>
                                {t("add_first_host")}
                            </Button>
                        </div>
                    )}

                    {!isLoading && (hosts?.length ?? 0) > 0 && (
                        <>
                            {recentHostEntries.length > 0 && (
                                <section>
                                    <div className="section-head is-first">{t("sections_recent")}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {/* 与下方分组胶囊共用同一套尺寸与间距，避免两排胶囊高低不一 */}
                                        {recentHostEntries.map((host) => (
                                            <button
                                                key={host.id}
                                                type="button"
                                                title={`${host.username}@${host.host}:${host.port}`}
                                                className="group-chip"
                                                onClick={() => handleConnect(host)}
                                            >
                                                <Clock3 className="size-3.5 shrink-0"/>
                                                <span className="max-w-40 truncate">
                                                    {host.name || fallbackHostName(host.username, host.host)}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {groupEntries.length > 0 && (
                                <section>
                                    <div className={cn("section-head", recentHostEntries.length === 0 && "is-first")}>{t("sections_groups")}</div>
                                    {/* 分组是筛选条件而非内容：用紧凑胶囊，避免与下方主机卡片争夺层级 */}
                                    <div className="flex flex-wrap gap-1.5">
                                        {groupEntries.map(([group, count]) => (
                                            <button
                                                key={group}
                                                type="button"
                                                className={cn("group-chip", selectedGroup === group && "is-active")}
                                                onClick={() => setSelectedGroup((prev) => prev === group ? null : group)}
                                                title={t("group_hosts", {count})}
                                            >
                                                <LayoutGrid className="size-3.5 shrink-0"/>
                                                <span className="max-w-40 truncate">{group}</span>
                                                <span className="group-chip-count">{count}</span>
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}

                            <section>
                                <div className={cn("section-head", groupEntries.length === 0 && recentHostEntries.length === 0 && "is-first")}>
                                    {t("sections_hosts")}
                                </div>
                                <div className="card-grid">
                                    {visibleHosts.map((host) => (
                                        <HostCard
                                            key={host.id}
                                            host={host}
                                            selected={selectedHostId === host.id}
                                            onSelect={handleSelect}
                                            onConnect={handleConnect}
                                            onEdit={handleEdit}
                                            onDelete={handleDeletePrompt}
                                        />
                                    ))}
                                </div>
                            </section>

                            {visibleHosts.length === 0 && (
                                <div className="py-12 text-center text-sm text-[var(--fg-muted)]">
                                    {t("no_search_results")}
                                </div>
                            )}
                        </>
                    )}
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
                open={panelOpen}
                onClose={closePanel}
                title={editingHost ? t("host_details") : t("new_title")}
                subtitle={editingHost
                    ? `${editingHost.username}@${editingHost.host}`
                    : t("form_subtitle")}
                actions={editingHost ? (
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className="cursor-pointer rounded-md p-1.5 text-[var(--fg-muted)]
                                           transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                                aria-label={t("more_actions", {ns: "common"})}
                            >
                                <MoreHorizontal className="size-4"/>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                                className="text-[var(--destructive)] focus:text-[var(--destructive)]"
                                onClick={() => handleDeletePrompt(editingHost)}
                            >
                                <Trash2 className="mr-2 size-4"/>
                                {t("delete_host")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : undefined}
                contentClassName="space-y-0 p-5"
                footer={
                    <div className="flex flex-col gap-2">
                        {editingHost && (
                            <Button
                                type="button"
                                variant="outline"
                                className="h-10 w-full"
                                onClick={() => handleConnect(editingHost)}
                                disabled={saveMutation.isPending}
                            >
                                {t("connect_now")}
                            </Button>
                        )}
                        <Button
                            type="submit"
                            form={HOST_FORM_ID}
                            className="h-10 w-full"
                            disabled={saveMutation.isPending}
                        >
                            {saveMutation.isPending ? t("saving", {ns: "common"}) : t("save_host")}
                        </Button>
                    </div>
                }
            >
                <HostForm
                    initialData={editingHost}
                    isSaving={saveMutation.isPending}
                    onSave={handleSave}
                />
            </SlidePanel>
        </div>
    );
}
