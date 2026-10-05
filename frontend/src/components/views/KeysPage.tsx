import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyCard } from "@/components/views/KeyCard";
import { KeyForm } from "@/components/views/KeyForm";
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
    const [showForm, setShowForm] = useState(false);
    const [editingKey, setEditingKey] = useState<SavedKey | null>(null);
    const [keyToDelete, setKeyToDelete] = useState<SavedKey | null>(null);

    const handleCreateNew = () => {
        setEditingKey(null);
        setShowForm(true);
    };

    const handleEdit = (key: SavedKey) => {
        setEditingKey(key);
        setShowForm(true);
    };

    const handleDeletePrompt = (key: SavedKey) => {
        setKeyToDelete(key);
    };

    const handleConfirmDelete = () => {
        if (keyToDelete && !deleteMutation.isPending) {
            deleteMutation.mutate(keyToDelete.id, {
                onSuccess: () => setKeyToDelete(null),
            });
        }
    };

    const handleSave = (key: SavedKey) => {
        saveMutation.mutate(key, {onSuccess: () => setShowForm(false)});
    };

    const filteredKeys = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return keys?.filter((k) => k.name.toLowerCase().includes(query));
    }, [keys, searchQuery]);

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
                    {keys?.length ?? 0}
                </span>
                <div className="flex-1"/>
                <div className="relative w-64 min-w-0 shrink">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                    <Input
                        placeholder={t("search_keys")}
                        className="h-[var(--control-height)] w-full border-[var(--hairline)]
                                   bg-[var(--surface-0)] pl-8 text-[12.5px]"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button onClick={handleCreateNew} className="h-[var(--control-height)] shrink-0">
                    <Plus/>
                    {t("new_key")}
                </Button>
            </div>

            {/* 列表：卡片网格 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {isLoading && <div className="px-2 py-4 text-sm text-[var(--fg-muted)]">{t("loading_keys")}</div>}

                {!isLoading && keys?.length === 0 && (
                    <div className="soft-card mt-4 flex flex-col items-center justify-center py-20 text-center
                                    rounded-xl">
                        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Key className="size-6"/>
                        </div>
                        <h3 className="text-lg font-semibold text-[var(--fg-strong)]">{t("empty_title")}</h3>
                        <p className="mb-4 mt-2 text-sm text-[var(--fg-muted)]">{t("empty_desc")}</p>
                        <Button variant="outline" onClick={handleCreateNew}>{t("import_key")}</Button>
                    </div>
                )}

                <div className="list-rows mt-2">
                    {filteredKeys?.map((key) => (
                        <KeyCard
                            key={key.id}
                            savedKey={key}
                            onEdit={handleEdit}
                            onDelete={handleDeletePrompt}
                        />
                    ))}
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
        </div>

            <SlidePanel
                open={showForm}
                onClose={() => setShowForm(false)}
                title={editingKey ? t("edit_title") : t("new_title")}
            >
                <KeyForm
                    initialData={editingKey}
                    isSaving={saveMutation.isPending}
                    onSave={handleSave}
                    onCancel={() => setShowForm(false)}
                />
            </SlidePanel>
        </div>
    );
}