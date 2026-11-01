import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Dialogs } from "@wailsio/runtime";
import { Search, Plus, Pencil, Trash2, ChevronDown, Terminal as TerminalIcon, FolderOpen, MonitorUp, Pin, MoreHorizontal, Upload, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useSnippetStore } from "@/store/snippetStore";
import { useSessionStore } from "@/store/sessionStore";
import { renderSnippetCommand } from "@/lib/snippets";
import { sendSessionInput } from "@/lib/sessionTransport";
import { Snippet, ItemType, SnippetService } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { TextFileService } from "../../../bindings/terminator-desktop/backend/internal/services/fileio";
import { handleAppError } from "@/lib/error";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** 导入的片段条目上限：避免一份异常大的 JSON 一次写入数千条 */
const MAX_IMPORT_COUNT = 500;
const MAX_FIELD_LENGTH = 200;
const MAX_COMMAND_LENGTH = 10000;
const MAX_DESCRIPTION_LENGTH = 500;

interface ImportedSnippet {
    name: string;
    group?: string;
    description?: string;
    command: string;
    pinned: boolean;
}

/**
 * 规范化导入条目
 * 只接受字符串字段并限制长度，非法条目返回 null 由调用方计为跳过。
 */
function normalizeImportedSnippet(item: unknown): ImportedSnippet | null {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_FIELD_LENGTH) : "";
    const command = typeof raw.command === "string" ? raw.command.slice(0, MAX_COMMAND_LENGTH) : "";
    if (!name || !command.trim()) return null;
    const group = typeof raw.group === "string" ? raw.group.trim().slice(0, MAX_FIELD_LENGTH) : "";
    const description = typeof raw.description === "string"
        ? raw.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
        : "";
    return {
        name,
        command,
        group: group || undefined,
        description: description || undefined,
        pinned: raw.pinned === true,
    };
}

interface SnippetPanelProps {
    /** 当前活跃终端会话 ID */
    sessionId: string | null;
}

export function SnippetPanel({ sessionId }: SnippetPanelProps) {
    const { t } = useTranslation("terminal");
    const { snippets, isLoading, loadSnippets, saveSnippet, deleteSnippet } = useSnippetStore();

    // 搜索关键字
    const [searchQuery, setSearchQuery] = useState("");
    // 新增/编辑弹窗
    const [showForm, setShowForm] = useState(false);
    const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
    // 删除确认弹窗
    const [snippetToDelete, setSnippetToDelete] = useState<Snippet | null>(null);
    // 保存中状态
    const [isSaving, setIsSaving] = useState(false);
    // 折叠的分组
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

    // 表单字段
    const [formName, setFormName] = useState("");
    const [formGroup, setFormGroup] = useState("");
    const [formDescription, setFormDescription] = useState("");
    const [formCommand, setFormCommand] = useState("");
    const [formPinned, setFormPinned] = useState(false);

    // 组件挂载时加载代码片段
    useEffect(() => {
        loadSnippets();
    }, [loadSnippets]);

    // 收集已有分组用于自动补全
    const existingGroups = useMemo(() => {
        const groups = new Set<string>();
        snippets.forEach((s) => {
            if (s.group) groups.add(s.group);
        });
        return Array.from(groups).sort();
    }, [snippets]);

    // 填入代码片段：只写进当前终端命令行，不自动回车。
    // 这是默认行为：片段里的参数、目标目录仍需要用户确认后才执行。
    const handleInsert = (snippet: Snippet) => {
        if (!sessionId) return;
        const state = useSessionStore.getState();
        const session = state.sessions.find((s) => s.id === sessionId);
        const command = renderSnippetCommand(snippet.command, session);
        sendSessionInput(sessionId, command).catch(console.error);
    };

    // 执行代码片段：将命令发送到活跃终端（变量按当前会话展开）
    // 统一走会话传输路由，本地终端标签也能执行片段。
    const handleExecute = (snippet: Snippet) => {
        if (!sessionId) return;
        const state = useSessionStore.getState();
        const session = state.sessions.find((s) => s.id === sessionId);
        const command = renderSnippetCommand(snippet.command, session);
        sendSessionInput(sessionId, command + "\n").catch(console.error);
        // 广播模式：同时发送到其他所有活跃终端
        if (state.broadcastMode) {
            for (const id of state.getActiveSessionIds().filter((id) => id !== sessionId)) {
                const other = state.sessions.find((s) => s.id === id);
                sendSessionInput(id, renderSnippetCommand(snippet.command, other) + "\n").catch(() => {});
            }
        }
    };

    // 在所有已连接会话中执行同一片段（每个会话独立展开变量）
    const handleExecuteOnAll = (snippet: Snippet) => {
        const state = useSessionStore.getState();
        const ids = state.getActiveSessionIds();
        for (const id of ids) {
            const session = state.sessions.find((s) => s.id === id);
            sendSessionInput(id, renderSnippetCommand(snippet.command, session) + "\n").catch(() => {});
        }
    };

    // 打开新增弹窗
    const handleCreateNew = () => {
        setEditingSnippet(null);
        setFormName("");
        setFormGroup("");
        setFormDescription("");
        setFormCommand("");
        setFormPinned(false);
        setShowForm(true);
    };

    // 打开编辑弹窗
    const handleEdit = (snippet: Snippet) => {
        setEditingSnippet(snippet);
        setFormName(snippet.name);
        setFormGroup(snippet.group || "");
        setFormDescription(snippet.description || "");
        setFormCommand(snippet.command);
        setFormPinned(!!snippet.pinned);
        setShowForm(true);
    };

    // 保存代码片段
    const handleSave = async () => {
        if (!formName.trim() || !formCommand.trim()) return;
        setIsSaving(true);
        try {
            await saveSnippet({
                id: editingSnippet?.id || "",
                name: formName.trim(),
                group: formGroup.trim() || undefined,
                description: formDescription.trim() || undefined,
                command: formCommand,
                pinned: formPinned,
                type: ItemType.TypeSnippet,
            });
            setShowForm(false);
        } catch (error) {
            console.error("保存代码片段失败:", error);
            toast.error(t("snippet_save_failed"));
        } finally {
            setIsSaving(false);
        }
    };

    // 置顶 / 取消置顶：直接保存整条片段，其余字段保持不变
    const handleTogglePin = async (snippet: Snippet) => {
        try {
            await saveSnippet({...snippet, pinned: !snippet.pinned});
        } catch (error) {
            console.error("切换置顶状态失败:", error);
            toast.error(t("snippet_pin_failed"));
        }
    };

    // 导出全部片段为 JSON：包含描述与置顶状态，便于在另一台设备还原
    const handleExport = async () => {
        if (snippets.length === 0) {
            toast.info(t("snippet_export_empty"));
            return;
        }
        const payload = {
            version: 1,
            snippets: snippets.map(({name, group, description, command, pinned}) => ({
                name,
                group,
                description,
                command,
                pinned: !!pinned,
            })),
        };
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        try {
            const path = await Dialogs.SaveFile({
                Title: t("snippet_export"),
                Filename: `terminator-snippets-${stamp}.json`,
            });
            if (!path) return;
            await TextFileService.SaveText(path, JSON.stringify(payload, null, 2));
            toast.success(t("snippet_export_success", {count: snippets.length}));
        } catch (err) {
            if (/cancel/i.test(String((err as Error)?.message ?? err))) return;
            handleAppError(err);
        }
    };

    // 从 JSON 导入片段：按名称+命令去重，非法条目跳过
    const handleImport = async () => {
        try {
            const picked = await Dialogs.OpenFile({
                Title: t("snippet_import"),
                CanChooseFiles: true,
                AllowsOtherFiletypes: true,
            });
            const path = Array.isArray(picked) ? picked[0] : picked;
            if (!path) return;

            const raw = await TextFileService.ReadText(path);
            const parsed: unknown = JSON.parse(raw);
            const candidates = Array.isArray(parsed)
                ? parsed
                : (parsed && typeof parsed === "object" && Array.isArray((parsed as {snippets?: unknown}).snippets))
                    ? (parsed as {snippets: unknown[]}).snippets
                    : null;
            if (!candidates) {
                toast.error(t("snippet_import_invalid"));
                return;
            }

            const existing = new Set(snippets.map((s) => `${s.name}\u0000${s.command}`));
            const pending: ImportedSnippet[] = [];
            let skipped = 0;
            for (const item of candidates.slice(0, MAX_IMPORT_COUNT)) {
                const normalized = normalizeImportedSnippet(item);
                if (!normalized) {
                    skipped++;
                    continue;
                }
                const key = `${normalized.name}\u0000${normalized.command}`;
                if (existing.has(key)) {
                    skipped++;
                    continue;
                }
                existing.add(key);
                pending.push(normalized);
            }

            if (pending.length === 0) {
                toast.info(t("snippet_import_empty", {count: skipped}));
                return;
            }

            // 直接逐条调用后端：store.saveSnippet 每次都会全量重载，
            // 批量导入时只应在全部写完后刷新一次列表。
            for (const item of pending) {
                await SnippetService.Save({
                    id: "",
                    type: ItemType.TypeSnippet,
                    name: item.name,
                    group: item.group ?? "",
                    description: item.description ?? "",
                    command: item.command,
                    pinned: item.pinned,
                });
            }
            await loadSnippets();
            toast.success(t("snippet_import_success", {count: pending.length}));
            if (skipped > 0) {
                toast.info(t("snippet_import_skipped", {count: skipped}));
            }
        } catch (err) {
            if (/cancel/i.test(String((err as Error)?.message ?? err))) return;
            handleAppError(err);
        }
    };

    // 确认删除
    const handleConfirmDelete = async () => {
        if (!snippetToDelete) return;
        try {
            await deleteSnippet(snippetToDelete.id);
            setSnippetToDelete(null);
        } catch (error) {
            console.error("删除代码片段失败:", error);
            toast.error(t("snippet_delete_failed"));
        }
    };

    // 切换分组折叠状态
    const toggleGroup = (group: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(group)) {
                next.delete(group);
            } else {
                next.add(group);
            }
            return next;
        });
    };

    // 按搜索关键字过滤：名称、命令、分组和描述都可命中
    const filteredSnippets = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return snippets;
        return snippets.filter(
            (s) =>
                s.name.toLowerCase().includes(query) ||
                s.command.toLowerCase().includes(query) ||
                (s.group || "").toLowerCase().includes(query) ||
                (s.description || "").toLowerCase().includes(query)
        );
    }, [snippets, searchQuery]);

    // 置顶片段单独成组显示在最上方，不再重复出现在原分组中
    const pinnedSnippets = useMemo(
        () => filteredSnippets
            .filter((s) => s.pinned)
            .sort((a, b) => a.name.localeCompare(b.name)),
        [filteredSnippets],
    );

    // 其余片段按 group 归类（无 group 归入"未分组"），组内按名称排序
    const groupedSnippets = useMemo(() => {
        const groups = new Map<string, Snippet[]>();
        for (const s of filteredSnippets) {
            if (s.pinned) continue;
            const group = s.group || t("snippet_ungrouped");
            if (!groups.has(group)) {
                groups.set(group, []);
            }
            groups.get(group)!.push(s);
        }
        return Array.from(groups.entries())
            .map(([group, items]) => [group, items.sort((a, b) => a.name.localeCompare(b.name))] as const)
            .sort((a, b) => a[0].localeCompare(b[0]));
    }, [filteredSnippets, t]);

    return (
        <div className="terminal-snippet-panel h-full">
            {/* 工具栏：搜索框 + 新增按钮 */}
            <div className="terminal-snippet-toolbar">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                    <Input
                        placeholder={t("snippet_search_placeholder")}
                        aria-label={t("snippet_search_placeholder")}
                        className="h-7 border-[var(--hairline)] bg-[var(--surface-2)] pl-8 text-xs"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button
                    size="xs"
                    variant="outline"
                    onClick={handleCreateNew}
                    className="shrink-0"
                >
                    <Plus/>
                    {t("snippet_add")}
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="xs"
                            variant="outline"
                            className="shrink-0 px-2"
                            aria-label={t("snippet_more")}
                            title={t("snippet_more")}
                        >
                            <MoreHorizontal/>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={handleImport}>
                            <Upload className="size-3.5"/>
                            {t("snippet_import")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleExport}>
                            <Download className="size-3.5"/>
                            {t("snippet_export")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* 代码片段列表区域 */}
            <div className="flex-1 overflow-y-auto px-3 pb-2">
                {isLoading && (
                    <div className="py-4 text-center text-xs text-[var(--fg-muted)]">
                        {t("snippet_loading")}
                    </div>
                )}

                {!isLoading && snippets.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                        <TerminalIcon className="mb-2 size-6 text-[var(--fg-subtle)]"/>
                        <p className="text-xs text-[var(--fg-muted)]">{t("snippet_empty")}</p>
                    </div>
                )}

                {!isLoading && snippets.length > 0 && filteredSnippets.length === 0 && (
                    <div className="py-4 text-center text-xs text-[var(--fg-muted)]">
                        {t("snippet_no_results")}
                    </div>
                )}

                {/* 置顶片段：固定显示在最上方，不参与分组折叠 */}
                {pinnedSnippets.length > 0 && (
                    <div className="mb-1">
                        <div className="terminal-group-head" style={{cursor: "default"}}>
                            <Pin className="size-3"/>
                            {t("snippet_pinned_group")}
                            <span className="text-[var(--fg-subtle)]">({pinnedSnippets.length})</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 pl-4">
                            {pinnedSnippets.map((snippet) => (
                                <SnippetChip
                                    key={snippet.id}
                                    snippet={snippet}
                                    sessionId={sessionId}
                                    onInsert={handleInsert}
                                    onExecute={handleExecute}
                                    onExecuteOnAll={handleExecuteOnAll}
                                    onEdit={handleEdit}
                                    onDelete={setSnippetToDelete}
                                    onTogglePin={handleTogglePin}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* 按分组渲染代码片段 */}
                {groupedSnippets.map(([group, items]) => {
                    const isCollapsed = collapsedGroups.has(group);
                    return (
                        <div key={group} className="mb-1">
                            {/* 分组标题（可折叠） */}
                            <button
                                onClick={() => toggleGroup(group)}
                                className="terminal-group-head"
                            >
                                <ChevronDown
                                    className={cn(
                                        "size-3 transition-transform",
                                        isCollapsed && "-rotate-90"
                                    )}
                                />
                                {group}
                                <span className="text-[var(--fg-subtle)]">({items.length})</span>
                            </button>

                            {/* 分组下的代码片段列表 */}
                            {!isCollapsed && (
                                <div className="flex flex-wrap gap-1.5 pl-4">
                                    {items.map((snippet) => (
                                        <SnippetChip
                                            key={snippet.id}
                                            snippet={snippet}
                                            sessionId={sessionId}
                                            onInsert={handleInsert}
                                            onExecute={handleExecute}
                                            onExecuteOnAll={handleExecuteOnAll}
                                            onEdit={handleEdit}
                                            onDelete={setSnippetToDelete}
                                            onTogglePin={handleTogglePin}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* 新增/编辑弹窗 */}
            <Dialog open={showForm} onOpenChange={(open) => !isSaving && setShowForm(open)}>
                <DialogContent className="overflow-hidden">
                    <DialogHeader className="min-w-0">
                        <DialogTitle>
                            {editingSnippet ? t("snippet_edit_title") : t("snippet_new_title")}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex min-w-0 flex-col gap-4 py-2">
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <Label>{t("snippet_name_label")}</Label>
                            <Input
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder={t("snippet_name_placeholder")}
                            />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <Label>{t("snippet_group_label")}</Label>
                            <div className="relative min-w-0">
                                <FolderOpen
                                    className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                                <Input
                                    list="snippet-existing-groups"
                                    className="pl-9"
                                    value={formGroup}
                                    onChange={(e) => setFormGroup(e.target.value)}
                                    placeholder={t("snippet_group_placeholder")}
                                />
                                <datalist id="snippet-existing-groups">
                                    {existingGroups.map((g) => (
                                        <option key={g} value={g}/>
                                    ))}
                                </datalist>
                            </div>
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <Label>{t("snippet_description_label")}</Label>
                            <Input
                                value={formDescription}
                                onChange={(e) => setFormDescription(e.target.value)}
                                placeholder={t("snippet_description_placeholder")}
                                maxLength={500}
                            />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <Label>{t("snippet_command_label")}</Label>
                            <Textarea
                                value={formCommand}
                                onChange={(e) => setFormCommand(e.target.value)}
                                placeholder={t("snippet_command_placeholder")}
                                className="min-h-20 font-mono text-xs"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
                            <input
                                type="checkbox"
                                className="size-3.5 accent-[var(--primary)]"
                                checked={formPinned}
                                onChange={(e) => setFormPinned(e.target.checked)}
                            />
                            {t("snippet_pin_label")}
                        </label>
                    </div>
                    <DialogFooter className="min-w-0">
                        <Button
                            variant="outline"
                            onClick={() => setShowForm(false)}
                            disabled={isSaving}
                        >
                            {t("snippet_cancel")}
                        </Button>
                        <Button
                            onClick={handleSave}
                            disabled={isSaving || !formName.trim() || !formCommand.trim()}
                        >
                            {isSaving ? t("snippet_saving") : t("snippet_save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 删除确认弹窗 */}
            <ConfirmModal
                isOpen={!!snippetToDelete}
                onClose={() => setSnippetToDelete(null)}
                onConfirm={handleConfirmDelete}
                title={t("snippet_delete_title")}
                description={t("snippet_delete_desc", { name: snippetToDelete?.name })}
                isDestructive={true}
            />
        </div>
    );
}

// ─── 代码片段标签组件 ──────────────────────────────────────────

interface SnippetChipProps {
    snippet: Snippet;
    sessionId: string | null;
    /** 点击：只填入终端，不自动执行 */
    onInsert: (snippet: Snippet) => void;
    onExecute: (snippet: Snippet) => void;
    /** 在所有已连接会话中执行（变量按各自会话展开） */
    onExecuteOnAll: (snippet: Snippet) => void;
    onEdit: (snippet: Snippet) => void;
    onDelete: (snippet: Snippet) => void;
    /** 置顶 / 取消置顶 */
    onTogglePin: (snippet: Snippet) => void;
}

function SnippetChip({ snippet, sessionId, onInsert, onExecute, onExecuteOnAll, onEdit, onDelete, onTogglePin }: SnippetChipProps) {
    const { t } = useTranslation("terminal");
    const menuTriggerRef = useRef<HTMLButtonElement>(null);

    // 右键菜单处理
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        menuTriggerRef.current?.click();
    };

    // 阻止操作按钮的点击冒泡到外层执行按钮
    const stopPropagation = (e: React.MouseEvent) => {
        e.stopPropagation();
    };

    // 悬浮提示：命令 + 描述（有描述时）+ 操作说明
    const chipTitle = [
        snippet.command,
        snippet.description,
        t("snippet_click_to_insert"),
    ].filter(Boolean).join("\n");

    return (
        <DropdownMenu>
            <div className="terminal-snippet-chip-wrap group relative inline-flex">
                {/* 代码片段按钮：左键只填入，右键弹出菜单（执行/在所有终端执行） */}
                <button
                    onClick={() => onInsert(snippet)}
                    onContextMenu={handleContextMenu}
                    disabled={!sessionId}
                    title={chipTitle}
                    className="terminal-snippet-chip"
                >
                    {snippet.pinned
                        ? <Pin className="size-3 shrink-0 text-[var(--primary)]"/>
                        : <TerminalIcon className="size-3 shrink-0 text-[var(--fg-subtle)]"/>}
                    <span className="max-w-32 truncate">{snippet.name}</span>
                </button>

                {/* 右键菜单触发器（隐藏，由右键事件触发） */}
                <DropdownMenuTrigger asChild>
                    <button ref={menuTriggerRef} className="sr-only" aria-label="menu">
                        <ChevronDown className="size-3"/>
                    </button>
                </DropdownMenuTrigger>

                {/* 可见的编辑按钮（hover 时显示） */}
                <button
                    onClick={(e) => { stopPropagation(e); onEdit(snippet); }}
                    title={t("snippet_edit")}
                    aria-label={t("snippet_edit")}
                    className="terminal-chip-action right-5"
                >
                    <Pencil className="size-3"/>
                </button>
                {/* 可见的删除按钮（hover 时显示） */}
                <button
                    onClick={(e) => { stopPropagation(e); onDelete(snippet); }}
                    title={t("snippet_delete")}
                    aria-label={t("snippet_delete")}
                    className="terminal-chip-action is-danger right-1"
                >
                    <Trash2 className="size-3"/>
                </button>
            </div>

            <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onInsert(snippet)}>
                    <TerminalIcon className="size-3.5"/>
                    {t("snippet_insert")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExecute(snippet)}>
                    <TerminalIcon className="size-3.5"/>
                    {t("snippet_run")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExecuteOnAll(snippet)}>
                    <MonitorUp className="size-3.5"/>
                    {t("snippet_run_all")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onTogglePin(snippet)}>
                    <Pin className="size-3.5"/>
                    {snippet.pinned ? t("snippet_unpin") : t("snippet_pin")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEdit(snippet)}>
                    <Pencil className="size-3.5"/>
                    {t("snippet_edit")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(snippet)}>
                    <Trash2 className="size-3.5"/>
                    {t("snippet_delete")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
