import { SyntheticEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, FolderSync, Loader2, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TestWebDAVConnection, SaveWebDAVConfig, GetWebDAVConfig } from "../../../bindings/terminator-desktop/backend/cmd/terminator-desktop/webdav";
import { SyncService } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { handleAppError } from "@/lib/error";

interface WebDAVModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

export function WebDAVModal({isOpen, onClose, onSuccess}: WebDAVModalProps) {
    const {t} = useTranslation(["settings", "common"]);
    const [url, setUrl] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isTesting, setIsTesting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [testResult, setTestResult] = useState<"none" | "success" | "error">("none");

    // 打开时加载已有配置，并清空密码字段（密码不回显，编辑时需重新输入或留空保留）
    useEffect(() => {
        if (isOpen) {
            setTestResult("none");
            setPassword("");
            GetWebDAVConfig()
                .then(([savedUrl, savedUser]) => {
                    if (savedUrl) setUrl(savedUrl);
                    if (savedUser) setUsername(savedUser);
                })
                .catch(() => {});
        }
    }, [isOpen]);

    const handleTest = async (e: SyntheticEvent) => {
        e.preventDefault();
        if (!url) return;
        setIsTesting(true);
        setTestResult("none");
        try {
            await TestWebDAVConnection(url, username, password);
            setTestResult("success");
        } catch (error) {
            setTestResult("error");
            handleAppError(error);
        } finally {
            setIsTesting(false);
        }
    };

    const handleSave = async (e: SyntheticEvent) => {
        e.preventDefault();
        if (!url) return;
        setIsSaving(true);
        try {
            await SaveWebDAVConfig(url, username, password);
            await SyncService.StartAutoSync();
            onSuccess();
            onClose();
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FolderSync className="size-5"/>
                        {t("webdav_title")}
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSave} className="grid gap-4 py-4">
                    <div className="flex items-start gap-3 p-4 text-info
                                    rounded-lg border border-info/20 bg-info/10">
                        <Cloud className="mt-0.5 size-5 shrink-0"/>
                        <div className="text-xs">
                            {t("webdav_info")}
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="webdav-url">{t("webdav_url_label")}</Label>
                        <Input
                            id="webdav-url"
                            placeholder="https://dav.jianguoyun.com/dav/"
                            required
                            value={url}
                            onChange={(e) => { setUrl(e.target.value); setTestResult("none"); }}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="webdav-username">{t("webdav_username_label")}</Label>
                        <Input
                            id="webdav-username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="webdav-password">{t("webdav_password_label")}</Label>
                        <Input
                            id="webdav-password"
                            type="password"
                            value={password}
                            onChange={(e) => { setPassword(e.target.value); setTestResult("none"); }}
                        />
                    </div>

                    {testResult === "success" && (
                        <div className="flex items-center gap-2 text-sm text-success">
                            <CheckCircle2 className="size-4"/>
                            {t("webdav_test_success")}
                        </div>
                    )}

                    <div className="mt-2 flex justify-between gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleTest}
                            disabled={isTesting || isSaving || !url}
                        >
                            {isTesting ? (
                                <><Loader2 className="mr-2 size-4 animate-spin"/>{t("testing", {ns: "common"})}</>
                            ) : (
                                t("webdav_test_btn")
                            )}
                        </Button>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={onClose}
                                disabled={isSaving}
                            >
                                {t("cancel", {ns: "common"})}
                            </Button>
                            <Button
                                type="submit"
                                disabled={isSaving || !url}
                            >
                                {isSaving ? (
                                    <><Loader2 className="mr-2 size-4 animate-spin"/>{t("saving", {ns: "common"})}</>
                                ) : (
                                    t("webdav_save_btn")
                                )}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
