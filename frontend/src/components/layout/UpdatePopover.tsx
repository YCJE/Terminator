import { ArrowDownToLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { UpdaterService } from "../../../bindings/terminator-desktop/backend/internal/services/updater";
import { useUIStore } from "@/store/uiStore";
import { handleAppError } from "@/lib/error";

export function UpdatePopover() {
    const {t} = useTranslation("update");
    const {
        updateVersionReady,
        setUpdateVersionReady,
        setDismissedUpdateVersion,
        updateReleaseUrl,
        updateReleaseVersion,
        setUpdateRelease,
    } = useUIStore();

    // 两种更新提示：
    // - updateVersionReady：velopack 已下载完成，可直接重启应用（仅在 cgo 可用时出现）
    // - updateReleaseUrl：仅检测到新版本，需用户去 Release 页手动下载
    const isManualDownload = !updateVersionReady && !!updateReleaseUrl;

    if (!updateVersionReady && !updateReleaseUrl) return null;

    const version = updateVersionReady ?? updateReleaseVersion ?? "";

    const handleRestartUpdate = async () => {
        try {
            await UpdaterService.ApplyAndRestart();
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleOpenDownload = async () => {
        if (!updateReleaseUrl) return;
        try {
            await UpdaterService.OpenReleasePage(updateReleaseUrl);
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleDismiss = () => {
        if (version) setDismissedUpdateVersion(version);
        if (updateVersionReady) {
            setUpdateVersionReady(null);
        } else {
            setUpdateRelease(null, null);
        }
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <div className="relative">
                    <button
                        type="button"
                        className="shell-nav-btn is-accent wails-no-drag"
                        title={isManualDownload ? t("update_available") : t("update_ready")}
                    >
                        <ArrowDownToLine className="size-[18px]"/>
                    </button>
                </div>
            </PopoverTrigger>

            <PopoverContent side="right" align="end" className="z-50 w-56 p-4">
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col">
                        <span className="font-semibold">
                            {isManualDownload ? t("update_available") : t("update_ready")}
                        </span>
                        <span className="text-xs text-[var(--fg-muted)]">
                            {t("update_to", {version})}
                        </span>
                    </div>
                    {isManualDownload ? (
                        <Button size="sm" onClick={handleOpenDownload} className="w-full">
                            {t("open_download_page")}
                        </Button>
                    ) : (
                        <Button size="sm" onClick={handleRestartUpdate} className="w-full">
                            {t("restart_update")}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={handleDismiss} className="w-full">
                        {t("later", {ns: "common", defaultValue: "Later"})}
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}