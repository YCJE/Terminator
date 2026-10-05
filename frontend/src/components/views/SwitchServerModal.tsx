import { SyntheticEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, UploadCloud } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthService } from "../../../bindings/terminator-desktop/backend/internal/services/auth";
import { SyncService } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { handleAppError } from "@/lib/error";
import { formatServerUrl } from "@/lib/utils.ts";
import { defaultServerUrl } from "@/lib/defaultServer.ts";

interface SwitchServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentUrl: string;
    onSuccess: () => void;
}

export function SwitchServerModal({isOpen, onClose, currentUrl, onSuccess}: SwitchServerModalProps) {
    const {t} = useTranslation(["settings", "common"]);
    const [url, setUrl] = useState(defaultServerUrl);
    const [isLoading, setIsLoading] = useState(false);

    const isSwitching = !!currentUrl;

    const handleConnect = async (e: SyntheticEvent) => {
        e.preventDefault();
        setIsLoading(true);

        try {
            // formatServerUrl 对非法输入会抛错，必须放在 try 内，
            // 否则 finally 不执行、isLoading 永远为 true，按钮会卡在"连接中"
            const cleanUrl = formatServerUrl(url);

            if (currentUrl && cleanUrl === currentUrl) {
                onClose();
                return;
            }

            await AuthService.RegisterOnServer(cleanUrl);
            await SyncService.StartAutoSync();
            onSuccess();
            onClose();
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md"
                           onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle>{
                        isSwitching
                            ? t("switch_server_title")
                            : t("connect_cloud_title")}
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleConnect} className="grid gap-4 py-4">
                    {isSwitching ? (
                        <div className="callout is-warning">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
                            <div>
                                {t("switch_warning", {url: currentUrl})}
                            </div>
                        </div>
                    ) : (
                        <div className="callout is-info">
                            <UploadCloud className="mt-0.5 size-3.5 shrink-0"/>
                            <div>
                                {t("connect_info")}
                            </div>
                        </div>
                    )}

                    <div className="grid gap-2">
                        <Label htmlFor="serverUrl">{t("new_server_url")}</Label>
                        <Input
                            id="serverUrl"
                            placeholder={defaultServerUrl}
                            required
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                        />
                    </div>

                    <div className="mt-4 flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                            disabled={isLoading}
                        >
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button
                            type="submit"
                            variant={isSwitching ? "destructive" : "default"}
                            disabled={isLoading || !url}
                        >
                            {isLoading
                                ? t("connecting", {ns: "common"})
                                : (isSwitching
                                        ? t("confirm_switch_btn")
                                        : t("register_sync_btn")
                                )
                            }
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}