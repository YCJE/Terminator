import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyCard } from "@/components/views/KeyCard";
import { KeyForm } from "@/components/views/KeyForm";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SlidePanel, panelMarginStyle } from "@/components/ui/slide-panel";
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
        if (keyToDelete) deleteMutation.mutate(keyToDelete.id);
        setKeyToDelete(null);
    };

    const handleSave = (key: SavedKey) => {
        saveMutation.mutate(key, {onSuccess: () => setShowForm(false)});
    };

    const filteredKeys = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return keys?.filter((k) => k.name.toLowerCase().includes(query));
    }, [keys, searchQuery]);

    return (
        <div className="relative h-full w-full">
        <div
            className="lazy-fade-in flex h-full w-full flex-col overflow-y-auto p-8"
            style={panelMarginStyle(showForm)}
        >

            <div className="mb-8 flex w-full items-center gap-4">
                <h1 className="shrink-0 text-2xl font-bold tracking-tight text-foreground">
                    {t("page_title")}
                </h1>
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                    <Input
                        placeholder={t("search_keys")}
                        className="w-full border-border bg-input/50 pl-9"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <Button onClick={handleCreateNew} className="shrink-0">
                    <Plus/>
                    {t("new_key")}
                </Button>
            </div>

            {isLoading && <div className="text-sm text-muted-foreground">{t("loading_keys")}</div>}

            {!isLoading && keys?.length === 0 && (
                <div className="soft-card flex flex-col items-center justify-center py-20 text-center
                                rounded-xl">
                    <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Key className="size-6"/>
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">{t("empty_title")}</h3>
                    <p className="mb-4 mt-2 text-sm text-muted-foreground">{t("empty_desc")}</p>
                    <Button variant="outline" onClick={handleCreateNew}>{t("import_key")}</Button>
                </div>
            )}

            <div
                className="grid w-full gap-4"
                style={{gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))"}}
            >
                {filteredKeys?.map((key, index) => (
                    <div key={key.id} className="stagger-in" style={{['--stagger-index' as string]: index}}>
                        <KeyCard
                            savedKey={key}
                            onEdit={handleEdit}
                            onDelete={handleDeletePrompt}
                        />
                    </div>
                ))}
            </div>

            <ConfirmModal
                isOpen={!!keyToDelete}
                onClose={() => setKeyToDelete(null)}
                onConfirm={handleConfirmDelete}
                title={t("delete_title")}
                description={t("delete_desc", {name: keyToDelete?.name})}
                confirmText={t("delete", {ns: "common"})}
                isDestructive={true}
            />
        </div>

            <SlidePanel
                open={showForm}
                onClose={() => setShowForm(false)}
                title={editingKey ? t("edit_title") : t("new_title")}
                width={400}
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