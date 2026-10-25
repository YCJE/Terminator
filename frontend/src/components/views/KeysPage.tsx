import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Key, MoreHorizontal, Trash2 } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyCard, getKeyTypeLabel } from "@/components/views/KeyCard";
import { KeyForm, KEY_FORM_ID } from "@/components/views/KeyForm";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SlidePanel } from "@/components/ui/slide-panel";
import { useKeys, useSaveKey, useDeleteKey } from "@/hooks/useKeys";
import { SavedKey } from "../../../bindings/terminator-desktop/backend/internal/services/blob";

export function KeysPage() {
    const {t} = useTranslation(["keys", "common"]);
    const {data: keys, isLoading} = useKeys();
    const saveMutation = useSaveKey();
    const deleteMutation = useDeleteKey();

    const [searchQuery, setSearchQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [editingKey, setEditingKey] = useState<SavedKey | null>(null);
    const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
    const [keyToDelete, setKeyToDelete] = useState<SavedKey | null>(null);

    const closePanel = () => {
        setPanelOpen(false);
        setEditingKey(null);
        setSelectedKeyId(null);
    };

    const handleCreateNew = () => {
        setEditingKey(null);
        setSelectedKeyId(null);
        setPanelOpen(true);
    };

    // 单击卡片：选中并在右侧详情面板查看/编辑（与主机页一致）
    const handleSelect = (key: SavedKey) => {
        setEditingKey(key);
        setSelectedKeyId(key.id);
        setPanelOpen(true);
    };

    const handleDeletePrompt = (key: SavedKey) => {
        setKeyToDelete(key);
    };

    const handleConfirmDelete = () => {
        if (keyToDelete && !deleteMutation.isPending) {
            if (selectedKeyId === keyToDelete.id) closePanel();
            deleteMutation.mutate(keyToDelete.id, {
                onSuccess: () => setKeyToDelete(null),
            });
        }
    };

    const handleSave = (key: SavedKey) => {
        saveMutation.mutate(key, {onSuccess: closePanel});
    };

    const filteredKeys = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return keys?.filter((k) => k.name?.toLowerCase().includes(query) ?? false);
    }, [keys, searchQuery]);

    return (
        <div className="flex h-full w-full overflow-hidden">
            <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
                {/* 工具栏：New key + 搜索（Termius Keychain 结构，无页面标题） */}
                <div className="page-header">
                    <div className="toolbar-row">
                        <button type="button" className="toolbar-btn is-solid" onClick={handleCreateNew}>
                            <Plus className="size-4"/>
                            {t("new_key")}
                        </button>
                        <div className="flex-1"/>
                        {searchOpen ? (
                            <div className="relative w-60">
                                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5
                                                 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                                <Input
                                    autoFocus
                                    placeholder={t("search_keys")}
                                    className="h-8 border-transparent bg-[var(--surface-2)] pl-8 text-[12.5px]"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onBlur={() => {
                                        if (!searchQuery) setSearchOpen(false);
                                    }}
                                />
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="toolbar-btn"
                                aria-label={t("search_keys")}
                                onClick={() => setSearchOpen(true)}
                            >
                                <Search className="size-4"/>
                            </button>
                        )}
                    </div>
                </div>

                {/* 列表：分区标题 + 卡片网格 */}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
                    {isLoading && (
                        <div className="py-4 text-sm text-[var(--fg-muted)]">{t("loading_keys")}</div>
                    )}

                    {!isLoading && keys?.length === 0 && (
                        <div className="empty-state">
                            <span className="empty-state-icon">
                                <Key className="size-5"/>
                            </span>
                            <h3 className="empty-state-title">{t("empty_title")}</h3>
                            <p className="empty-state-desc">{t("empty_desc")}</p>
                            <Button variant="outline" className="mt-4" onClick={handleCreateNew}>
                                {t("import_key")}
                            </Button>
                        </div>
                    )}

                    {!isLoading && (keys?.length ?? 0) > 0 && (
                        <>
                            <div className="section-head is-first">{t("page_title")}</div>
                            <div className="card-grid">
                                {filteredKeys?.map((key) => (
                                    <KeyCard
                                        key={key.id}
                                        savedKey={key}
                                        selected={selectedKeyId === key.id}
                                        onSelect={handleSelect}
                                        onDelete={handleDeletePrompt}
                                    />
                                ))}
                            </div>
                        </>
                    )}

                    {!isLoading && (keys?.length ?? 0) > 0 && filteredKeys?.length === 0 && (
                        <div className="py-12 text-center text-sm text-[var(--fg-muted)]">
                            {t("no_search_results")}
                        </div>
                    )}
                </div>

                <ConfirmModal
                    isOpen={!!keyToDelete}
                    onClose={() => !deleteMutation.isPending && setKeyToDelete(null)}
                    onConfirm={handleConfirmDelete}
                    title={t("delete_title")}
                    description={t("delete_desc", {name: keyToDelete?.name})}
                    confirmText={t("delete", {ns: "common"})}
                    isDestructive={true}
                    confirmDisabled={deleteMutation.isPending}
                />
            </div>

            <SlidePanel
                open={panelOpen}
                onClose={closePanel}
                title={editingKey ? t("edit_title") : t("new_title")}
                subtitle={editingKey
                    ? t("key_type", {type: getKeyTypeLabel(editingKey.privateKey)})
                    : t("empty_desc")}
                actions={editingKey ? (
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
                                onClick={() => handleDeletePrompt(editingKey)}
                            >
                                <Trash2 className="mr-2 size-4"/>
                                {t("delete", {ns: "common"})}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : undefined}
                contentClassName="space-y-0 p-5"
                footer={
                    <Button
                        type="submit"
                        form={KEY_FORM_ID}
                        className="h-10 w-full"
                        disabled={saveMutation.isPending}
                    >
                        {saveMutation.isPending
                            ? t("saving", {ns: "common"})
                            : t("save_key")}
                    </Button>
                }
            >
                <KeyForm
                    initialData={editingKey}
                    isSaving={saveMutation.isPending}
                    onSave={handleSave}
                />
            </SlidePanel>
        </div>
    );
}
