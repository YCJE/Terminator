import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Events } from "@wailsio/runtime";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, Loader2, Server, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/ui/settings-card";
import { SyncService } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import type { ConflictInfo } from "../../../bindings/terminator-desktop/backend/internal/services/sync/models";
import { AppEvent } from "@/lib/events";
import { formatDateTime } from "@/lib/format";
import { handleAppError } from "@/lib/error";
import { useSyncStore } from "@/store/syncStore";

// 条目类型对应的图标与文案键；未知类型统一退回通用样式
const TYPE_ICONS: Record<string, typeof Server> = {
    host: Server,
    key: KeyRound,
    snippet: Terminal,
};

const TYPE_LABEL_KEYS: Record<string, string> = {
    host: "conflict_type_host",
    key: "conflict_type_key",
    snippet: "conflict_type_snippet",
};

/**
 * 同步冲突面板：列出多端并发修改的同一条目，由用户选择保留本机还是云端版本。
 * 无冲突时不渲染任何内容，避免设置页出现无意义的空卡片。
 */
export function SyncConflictPanel() {
    const {t} = useTranslation(["settings", "common"]);
    const queryClient = useQueryClient();
    const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    const setConflictCount = useSyncStore((s) => s.setConflictCount);

    const refresh = useCallback(async () => {
        try {
            const list = await SyncService.ListConflicts();
            setConflicts(list);
            // 列表已是最新，顺带同步全局计数，省去一次 ConflictCount 调用
            setConflictCount(list.length);
        } catch (error) {
            handleAppError(error);
        }
    }, [setConflictCount]);

    useEffect(() => {
        refresh();
        // 每轮同步检测到冲突后会发出 updates-available，此时刷新冲突列表
        const unsubscribe = Events.On(AppEvent.SyncUpdatesAvailable, () => {
            refresh();
        });
        return () => unsubscribe();
    }, [refresh]);

    const resolve = async (blobId: string, keepLocal: boolean) => {
        setResolvingId(blobId);
        try {
            await SyncService.ResolveConflict(blobId, keepLocal);
            await refresh();
            // 选中的副本已写回本地，主机 / 密钥 / 片段列表需要重新拉取
            queryClient.invalidateQueries();
        } catch (error) {
            handleAppError(error);
        } finally {
            setResolvingId(null);
        }
    };

    if (conflicts.length === 0) {
        return null;
    }

    return (
        <SettingsCard title={t("conflict_title")} description={t("conflict_desc")}>
            {conflicts.map((conflict) => {
                const Icon = TYPE_ICONS[conflict.itemType] ?? AlertTriangle;
                const typeLabelKey = TYPE_LABEL_KEYS[conflict.itemType];
                const isBusy = resolvingId === conflict.blobId;

                return (
                    <div
                        key={conflict.blobId}
                        className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4"
                    >
                        <div className="flex items-center gap-4">
                            <div
                                className="flex size-10 shrink-0 items-center justify-center
                                           rounded-lg bg-destructive/10 text-destructive">
                                <Icon className="size-5"/>
                            </div>
                            <div className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium text-foreground">
                                    {conflict.name || t("conflict_unknown_item")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {typeLabelKey ? t(typeLabelKey) : t("conflict_unknown_item")}
                                </span>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2">
                                <span className="text-xs font-medium text-foreground">
                                    {t("conflict_local")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {formatDateTime(conflict.localUpdatedAt)}
                                </span>
                                {conflict.localDeleted && (
                                    <span className="text-xs text-destructive">
                                        {t("conflict_deleted")}
                                    </span>
                                )}
                            </div>
                            <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2">
                                <span className="text-xs font-medium text-foreground">
                                    {t("conflict_remote")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {formatDateTime(conflict.remoteUpdatedAt)}
                                </span>
                                {conflict.remoteDeleted && (
                                    <span className="text-xs text-destructive">
                                        {t("conflict_deleted")}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={isBusy}
                                onClick={() => resolve(conflict.blobId, true)}
                            >
                                {isBusy && <Loader2 className="mr-2 size-3 animate-spin"/>}
                                {t("conflict_keep_local")}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={isBusy}
                                onClick={() => resolve(conflict.blobId, false)}
                            >
                                {t("conflict_keep_remote")}
                            </Button>
                        </div>
                    </div>
                );
            })}
        </SettingsCard>
    );
}