import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, Plus, Pencil, Trash2, ChevronDown, Terminal as TerminalIcon, FolderOpen } from "lucide-react";
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
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { Snippet, ItemType } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
    const [formCommand, setFormCommand] = useState("");

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

    // 执行代码片段：将命令发送到活跃终端
    const handleExecute = (snippet: Snippet) => {
        if (!sessionId) return;
        SshService.Input(sessionId, snippet.command + "\n").catch(console.error);
        // 广播模式：同时发送到其他所有活跃终端
        const {broadcastMode, getActiveSessionIds} = useSessionStore.getState();
        if (broadcastMode) {
            const others = getActiveSessionIds().filter((id) => id !== sessionId);
            for (const id of others) {
                SshService.Input(id, snippet.command + "\n").catch(() => {});
            }
        }
    };

    // 打开新增弹窗
    const handleCreateNew = () => {
        setEditingSnippet(null);
        setFormName("");
        setFormGroup("");
        setFormCommand("");
        setShowForm(true);
    };

    // 打开编辑弹窗
    const handleEdit = (snippet: Snippet) => {
        setEditingSnippet(snippet);
        setFormName(snippet.name);
        setFormGroup(snippet.group || "");
        setFormCommand(snippet.command);
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
                command: formCommand,
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

    // 按搜索关键字过滤并按分组归类
    const groupedSnippets = useMemo(() => {
        const query = searchQuery.toLowerCase();
        const filtered = snippets.filter(
            (s) =>
                s.name.toLowerCase().includes(query) ||
                s.command.toLowerCase().includes(query) ||
                (s.group || "").toLowerCase().includes(query)
        );

        // 按 group 字段分组，无 group 的归入"未分组"
        const groups = new Map<string, Snippet[]>();
        for (const s of filtered) {
            const group = s.group || t("snippet_ungrouped");
            if (!groups.has(group)) {
                groups.set(group, []);
            }
            groups.get(group)!.push(s);
        }

        // 转为数组并按组名排序
        return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    }, [snippets, searchQuery, t]);

    return (
        <div className="flex h-full flex-col border-t border-border bg-background/80 backdrop-blur-sm">
            {/* 工具栏：搜索框 + 新增按钮 */}
            <div className="flex items-center gap-2 px-3 py-2">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"/>
                    <Input
                        placeholder={t("snippet_search_placeholder")}
                        className="h-7 border-border bg-input/50 pl-8 text-xs"
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
            </div>

            {/* 代码片段列表区域 */}
            <div className="flex-1 overflow-y-auto px-3 pb-2">
                {isLoading && (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                        {t("snippet_loading")}
                    </div>
                )}

                {!isLoading && snippets.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                        <TerminalIcon className="mb-2 size-6 text-muted-foreground/50"/>
                        <p className="text-xs text-muted-foreground">{t("snippet_empty")}</p>
                    </div>
                )}

                {!isLoading && snippets.length > 0 && groupedSnippets.length === 0 && (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                        {t("snippet_no_results")}
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
                                className="mb-1 flex w-full items-center gap-1 px-1 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ChevronDown
                                    className={cn(
                                        "size-3 transition-transform",
                                        isCollapsed && "-rotate-90"
                                    )}
                                />
                                {group}
                                <span className="text-muted-foreground/60">({items.length})</span>
                            </button>

                            {/* 分组下的代码片段列表 */}
                            {!isCollapsed && (
                                <div className="flex flex-wrap gap-1.5 pl-4">
                                    {items.map((snippet) => (
                                        <SnippetChip
                                            key={snippet.id}
                                            snippet={snippet}
                                            sessionId={sessionId}
                                            onExecute={handleExecute}
                                            onEdit={handleEdit}
                                            onDelete={setSnippetToDelete}
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
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {editingSnippet ? t("snippet_edit_title") : t("snippet_new_title")}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-4 py-2">
                        <div className="flex flex-col gap-1.5">
                            <Label>{t("snippet_name_label")}</Label>
                            <Input
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder={t("snippet_name_placeholder")}
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label>{t("snippet_group_label")}</Label>
                            <div className="relative">
                                <FolderOpen
                                    className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"/>
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
                        <div className="flex flex-col gap-1.5">
                            <Label>{t("snippet_command_label")}</Label>
                            <Textarea
                                value={formCommand}
                                onChange={(e) => setFormCommand(e.target.value)}
                                placeholder={t("snippet_command_placeholder")}
                                className="min-h-20 font-mono text-xs"
                            />
                        </div>
                    </div>
                    <DialogFooter>
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
    onExecute: (snippet: Snippet) => void;
    onEdit: (snippet: Snippet) => void;
    onDelete: (snippet: Snippet) => void;
}

function SnippetChip({ snippet, sessionId, onExecute, onEdit, onDelete }: SnippetChipProps) {
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

    return (
        <DropdownMenu>
            <div className="group relative inline-flex">
                {/* 代码片段按钮：左键执行，右键弹出菜单 */}
                <button
                    onClick={() => onExecute(snippet)}
                    onContextMenu={handleContextMenu}
                    disabled={!sessionId}
                    title={snippet.command}
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border border-border bg-input/30 px-2.5 py-1 pr-7 text-xs font-medium transition-colors",
                        "hover:bg-primary/10 hover:border-primary/30 hover:text-primary",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "cursor-pointer select-none"
                    )}
                >
                    <TerminalIcon className="size-3 shrink-0 text-muted-foreground"/>
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
                    className={cn(
                        "absolute right-5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm",
                        "text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground",
                        "opacity-0 group-hover:opacity-100"
                    )}
                >
                    <Pencil className="size-3"/>
                </button>
                {/* 可见的删除按钮（hover 时显示） */}
                <button
                    onClick={(e) => { stopPropagation(e); onDelete(snippet); }}
                    title={t("snippet_delete")}
                    aria-label={t("snippet_delete")}
                    className={cn(
                        "absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm",
                        "text-muted-foreground transition-all hover:bg-destructive/20 hover:text-destructive",
                        "opacity-0 group-hover:opacity-100"
                    )}
                >
                    <Trash2 className="size-3"/>
                </button>
            </div>

            <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onExecute(snippet)}>
                    <TerminalIcon className="size-3.5"/>
                    {t("snippet_run")}
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
