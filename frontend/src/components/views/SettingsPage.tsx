import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { User, Server, Lock, Trash2, Globe, AlertTriangle, Palette, Moon, Sun, Unplug, FolderSync, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SwitchServerModal } from "@/components/views/SwitchServerModal";
import { WebDAVModal } from "@/components/views/WebDAVModal";
import { LogViewer } from "@/components/views/LogViewer";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SettingsCard } from "@/components/ui/settings-card";
import { useCurrentUser } from "@/hooks/useAuth";
import { useAuthStore } from "@/store/authStore";
import { useSessionStore } from "@/store/sessionStore";
import { AuthService } from "../../../bindings/terminator-desktop/backend/internal/services/auth";
import { SyncService } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { AppSettings, SettingsService } from "../../../bindings/terminator-desktop/backend/internal/services/settings";
import { handleAppError } from "@/lib/error";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSyncStore } from "@/store/syncStore.ts";
import { useUIStore, Theme } from "@/store/uiStore.ts";

export function SettingsPage() {
    const {t, i18n} = useTranslation(["settings", "common", "errors"]);
    const {data: user, refetch} = useCurrentUser();
    const {setUnlocked, setHasUser} = useAuthStore();
    const {clearSessions} = useSessionStore();
    const {lastError} = useSyncStore();
    const {theme, setTheme} = useUIStore();

    const [isServerModalOpen, setIsServerModalOpen] = useState(false);
    const [isWipeModalOpen, setIsWipeModalOpen] = useState(false);
    const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);
    const [isWebDAVModalOpen, setIsWebDAVModalOpen] = useState(false);
    const [syncMethod, setSyncMethod] = useState<string>("server");
    const [webdavUrl, setWebdavUrl] = useState<string>("");

    // 读取当前同步方式
    useEffect(() => {
        SettingsService.GetSettings()
            .then((s) => {
                setSyncMethod(s.sync_method || "server");
                setWebdavUrl(s.webdav_url || "");
            })
            .catch(() => {});
    }, [isWebDAVModalOpen, isServerModalOpen]);

    const handleLockVault = async () => {
        try {
            clearSessions();
            await AuthService.LockVault();
            setUnlocked(false);
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleWipeData = async () => {
        try {
            clearSessions();
            await AuthService.WipeData();
            setUnlocked(false);
            setHasUser(false);
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleDisconnectCloud = async () => {
        try {
            await SyncService.StopAutoSync();
            await AuthService.DisconnectCloud();
            await refetch();
        } catch (error) {
            handleAppError(error);
        }
    };

    const changeLanguage = async (lng: string) => {
        try {
            const current = await SettingsService.GetSettings();

            const updated = new AppSettings({
                ...current,
                language: lng,
            });

            await SettingsService.SaveSettings(updated);
            void i18n.changeLanguage(lng);
        } catch (error) {
            handleAppError(error);
        }
    };

    const changeTheme = async (newTheme: Theme) => {
        const prevTheme = theme;
        try {
            setTheme(newTheme);
            const current = await SettingsService.GetSettings();
            const updated = new AppSettings({
                ...current,
                theme: newTheme,
            });
            await SettingsService.SaveSettings(updated);
        } catch (error) {
            // Rollback on failure to keep UI and persisted state consistent.
            setTheme(prevTheme);
            handleAppError(error);
        }
    };

    return (
        <div className="lazy-fade-in flex h-full w-full flex-col overflow-y-auto p-8">

            <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("page_title")}</h1>

                <SettingsCard title={t("profile_sync_title")} description={t("profile_sync_desc")}>
                    {/* 账户信息 */}
                    <div className="flex items-center gap-4">
                        <div
                            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                            <User className="size-6"/>
                        </div>
                        <div className="flex flex-col">
                            <span
                                className="text-sm font-medium text-muted-foreground">{t("username", {ns: "common"})}</span>
                            <span className="text-lg font-semibold text-foreground">
                                {user?.username || t("loading", {ns: "common"})}
                            </span>
                        </div>
                    </div>

                    {lastError && (
                        <div className="p-4 flex items-start gap-3 text-destructive
                                        border border-destructive/20 bg-destructive/10 rounded-lg">
                            <AlertTriangle className="mt-0.5 size-5 shrink-0" />
                            <div className="flex flex-col">
                                <span className="text-sm font-medium">{t("sync_offline")}</span>
                                <span className="text-xs opacity-90">
                                    {t(`errors:${lastError.code}`, { defaultValue: lastError.message })}
                                </span>
                                {lastError.detailsString && (
                                    <span className="mt-1 text-2xs font-mono opacity-75">
                                        {lastError.detailsString}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* 同步方式分隔线 */}
                    <div className="my-2 h-px w-full bg-border"/>

                    {/* 服务器同步 */}
                    <div className="flex items-center justify-between
                                   rounded-lg border border-border bg-background p-4">
                        <div className="flex items-center gap-4">
                            <div className="flex size-10 shrink-0 items-center justify-center
                                           rounded-lg bg-primary/10 text-primary">
                                <Server className="size-5"/>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-foreground">
                                    {t("sync_server_title")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {syncMethod === "server" && user?.serverUrl
                                        ? user.serverUrl
                                        : t("sync_server_desc")}
                                </span>
                            </div>
                        </div>
                        <Button variant={syncMethod === "server" ? "secondary" : "outline"}
                                onClick={() => setIsServerModalOpen(true)}>
                            {user?.serverUrl ? t("switch_server_btn") : t("connect_btn")}
                        </Button>
                    </div>

                    {syncMethod === "server" && user?.serverUrl && (
                        <div className="flex justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setIsDisconnectModalOpen(true)}>
                                <Unplug className="mr-2 size-4"/>
                                {t("disconnect_btn")}
                            </Button>
                        </div>
                    )}

                    {/* WebDAV 同步 */}
                    <div className="mt-2 flex items-center justify-between
                                   rounded-lg border border-border bg-background p-4">
                        <div className="flex items-center gap-4">
                            <div className="flex size-10 shrink-0 items-center justify-center
                                           rounded-lg bg-accent/10 text-accent">
                                <FolderSync className="size-5"/>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-foreground">
                                    {t("webdav_title")}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {syncMethod === "webdav" && webdavUrl
                                        ? webdavUrl
                                        : t("webdav_card_desc")}
                                </span>
                            </div>
                        </div>
                        <Button variant={syncMethod === "webdav" ? "secondary" : "outline"}
                                onClick={() => setIsWebDAVModalOpen(true)}>
                            {syncMethod === "webdav" ? t("webdav_edit_btn") : t("webdav_setup_btn")}
                        </Button>
                    </div>
                </SettingsCard>

                <SettingsCard title={t("preferences_title")}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div
                                className="flex size-10 shrink-0 items-center justify-center
                                           rounded-lg bg-primary/10 text-primary">
                                <Globe className="size-5"/>
                            </div>
                            <span className="text-sm font-medium text-foreground">
                                {t("language_label")}
                            </span>
                        </div>
                        <Select value={i18n.resolvedLanguage} onValueChange={changeLanguage}>
                            <SelectTrigger className="w-45">
                                <SelectValue placeholder={t("select_language")}/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="en">English</SelectItem>
                                <SelectItem value="zh">中文</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="my-2 h-px w-full bg-border"/>

                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div
                                className="flex size-10 shrink-0 items-center justify-center
                                           rounded-lg bg-primary/10 text-primary">
                                <Palette className="size-5"/>
                            </div>
                            <span className="text-sm font-medium text-foreground">
                                {t("theme_label")}
                            </span>
                        </div>
                        <Select value={theme} onValueChange={(v) => changeTheme(v as Theme)}>
                            <SelectTrigger className="w-45">
                                <SelectValue placeholder={t("select_theme")}/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="dark">
                                    <span className="flex items-center gap-2">
                                        <Moon className="size-4"/>
                                        {t("theme_dark")}
                                    </span>
                                </SelectItem>
                                <SelectItem value="light">
                                    <span className="flex items-center gap-2">
                                        <Sun className="size-4"/>
                                        {t("theme_light")}
                                    </span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </SettingsCard>

                <SettingsCard title={t("security_title")} description={t("security_desc")}>
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="font-medium text-foreground">{t("lock_vault_title")}</span>
                            <span className="text-xs text-muted-foreground">{t("lock_vault_desc")}</span>
                        </div>
                        <Button variant="outline" onClick={handleLockVault}>
                            <Lock className="mr-2 size-4"/>
                            {t("lock_btn")}
                        </Button>
                    </div>

                    <div className="my-2 h-px w-full bg-border"/>

                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="font-medium text-destructive">{t("wipe_data_title")}</span>
                            <span className="text-xs text-muted-foreground">{t("wipe_data_desc")}</span>
                        </div>
                        <Button variant="destructive" onClick={() => setIsWipeModalOpen(true)}>
                            <Trash2 className="mr-2 size-4"/>
                            {t("wipe_btn")}
                        </Button>
                    </div>
                </SettingsCard>

                {/* 日志查看器 */}
                <SettingsCard icon={<ScrollText className="size-5"/>} title={t("log_section_title")}>
                    <LogViewer/>
                </SettingsCard>

            </div>

            <SwitchServerModal
                isOpen={isServerModalOpen}
                onClose={() => setIsServerModalOpen(false)}
                currentUrl={user?.serverUrl || ""}
                onSuccess={() => refetch()}
            />

            <WebDAVModal
                isOpen={isWebDAVModalOpen}
                onClose={() => setIsWebDAVModalOpen(false)}
                onSuccess={() => refetch()}
            />

            <ConfirmModal
                isOpen={isWipeModalOpen}
                onClose={() => setIsWipeModalOpen(false)}
                onConfirm={handleWipeData}
                title={t("wipe_confirm_title")}
                description={t("wipe_confirm_desc")}
                confirmText={t("nuke_it")}
                isDestructive={true}
            />

            <ConfirmModal
                isOpen={isDisconnectModalOpen}
                onClose={() => setIsDisconnectModalOpen(false)}
                onConfirm={handleDisconnectCloud}
                title={t("disconnect_confirm_title")}
                description={t("disconnect_confirm_desc")}
                confirmText={t("disconnect_btn")}
                isDestructive={true}
            />

        </div>
    );
}