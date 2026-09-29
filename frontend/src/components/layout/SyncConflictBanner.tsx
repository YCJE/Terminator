import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSyncStore } from "@/store/syncStore.ts";
import { useUIStore } from "@/store/uiStore.ts";

/**
 * 同步冲突全局横幅：有未解决冲突时常驻在标题栏下方，提示用户去处理。
 *
 * 冲突条目在多端同时修改时产生，若用户不进设置页就可能长期忽略，
 * 因此这里做全局提示，点击后直接跳转到设置页的同步分类。
 */
export function SyncConflictBanner() {
    const {t} = useTranslation(["settings", "common"]);
    const conflictCount = useSyncStore((s) => s.conflictCount);
    const openSettingsSection = useUIStore((s) => s.openSettingsSection);

    if (conflictCount <= 0) {
        return null;
    }

    return (
        <div className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2">
            <AlertTriangle className="size-4 shrink-0 text-destructive"/>
            <span className="flex-1 text-sm text-foreground">
                {t("conflict_banner_message", {ns: "settings", count: conflictCount})}
            </span>
            <Button
                variant="outline"
                size="sm"
                className="wails-no-drag shrink-0"
                onClick={() => openSettingsSection("sync")}
            >
                {t("conflict_banner_action", {ns: "settings"})}
            </Button>
        </div>
    );
}
