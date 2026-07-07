import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { User, Server, Lock, Trash2, Globe, AlertTriangle, Palette, Moon, Sun, Unplug, FolderSync, ScrollText, Download, ExternalLink, Loader2, CheckCircle2, type LucideIcon } from "lucide-react";
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
import { UpdaterService } from "../../../bindings/terminator-desktop/backend/internal/services/updater";
import { GitHubReleaseInfo } from "../../../bindings/terminator-desktop/backend/internal/services/updater/models";
import { handleAppError } from "@/lib/error";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSyncStore } from "@/store/syncStore.ts";
import { useUIStore, Theme, ACCENT_PRESETS, SPACINESS_PRESETS, type AccentColor, type Spaciness } from "@/store/uiStore.ts";
import { applyTerminalColorLink } from "@/lib/terminalTheme";
import { cn } from "@/lib/utils";

type SettingsCategory = "appearance" | "terminal" | "sync" | "security" | "about";

const NAV_ITEMS: { id: SettingsCategory; labelKey: string; icon: LucideIcon }[] = [
    { id: "appearance", labelKey: "nav_appearance", icon: Palette },
    { id: "terminal", labelKey: "nav_terminal", icon: ScrollText },
    { id: "sync", labelKey: "nav_sync", icon: Server },
    { id: "security", labelKey: "nav_security", icon: Lock },
    { id: "about", labelKey: "nav_about", icon: Download },
];

export function SettingsPage() {
    const {t, i18n} = useTranslation(["settings", "common", "errors"]);
    const {data: user, refetch} = useCurrentUser();
    const {setUnlocked, setHasUser} = useAuthStore();
    const {clearSessions} = useSessionStore();
    const {lastError} = useSyncStore();
    const {theme, setTheme, accentColor, setAccentColor, spaciness, setSpaciness, terminalColorLink, setTerminalColorLink} = useUIStore();
    const queryClient = useQueryClient();

    const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
    const [isServerModalOpen, setIsServerModalOpen] = useState(false);
    const [isWipeModalOpen, setIsWipeModalOpen] = useState(false);
    const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);
    const [isWebDAVModalOpen, setIsWebDAVModalOpen] = useState(false);
    const [syncMethod, setSyncMethod] = useState<string>("server");
    const [webdavUrl, setWebdavUrl] = useState<string>("");

    // 更新检查状态
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [releaseInfo, setReleaseInfo] = useState<GitHubReleaseInfo | null>(null);

    // 读取当前同步方式
    useEffect(() => {
        SettingsService.GetSettings()
            .then((s) => {
                setSyncMethod(s.sync_method || "server");
                setWebdavUrl(s.webdav_url || "");
            })
            .catch(() => {});
    }, [isWebDAVModalOpen, isServerModalOpen]);

    // 挂载时将 store 中的强调色 / 密度同步到 DOM
    useEffect(() => {
        document.documentElement.setAttribute("data-accent", accentColor);
        document.documentElement.style.setProperty("--spaciness", String(spaciness));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 主题变化或强调色变化时重新应用终端配色联动
    useEffect(() => {
        if (terminalColorLink) {
            applyTerminalColorLink(theme, accentColor, true);
        }
    }, [theme, terminalColorLink, accentColor]);

    const handleLockVault = async () => {
        try {
            await AuthService.LockVault();
            clearSessions();
            queryClient.clear();
            setUnlocked(false);
        } catch (error) {
            handleAppError(error);
        }
    };

    const handleWipeData = async () => {
        try {
            await AuthService.WipeData();
            clearSessions();
            queryClient.clear();
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

    const handleCheckUpdate = async () => {
        setIsCheckingUpdate(true);
        setReleaseInfo(null);
        try {
            const info = await UpdaterService.CheckGitHubReleases();
            if (info) {
                setReleaseInfo(info);
            } else {
                handleAppError(new Error("Failed to check for updates"));
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleOpenReleasePage = async () => {
        if (releaseInfo?.htmlUrl) {
            try {
                await UpdaterService.OpenReleasePage(releaseInfo.htmlUrl);
            } catch {
                window.open(releaseInfo.htmlUrl, "_blank");
            }
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

    const handleAccentChange = async (color: AccentColor) => {
        const prev = accentColor;
        try {
            setAccentColor(color);
            document.documentElement.setAttribute("data-accent", color);
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                accent_color: color,
            }));
        } catch (error) {
            setAccentColor(prev);
            document.documentElement.setAttribute("data-accent", prev);
            handleAppError(error);
        }
    };

    const handleSpacinessChange = async (s: Spaciness) => {
        const prev = spaciness;
        try {
            setSpaciness(s);
            document.documentElement.style.setProperty("--spaciness", String(s));
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                spaciness: s,
            }));
        } catch (error) {
            setSpaciness(prev);
            document.documentElement.style.setProperty("--spaciness", String(prev));
            handleAppError(error);
        }
    };

    const handleTerminalColorLinkChange = async (enabled: boolean) => {
        try {
            setTerminalColorLink(enabled);
            applyTerminalColorLink(theme, accentColor, enabled);
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                terminal_color_link: enabled,
            }));
        } catch (error) {
            setTerminalColorLink(!enabled);
            handleAppError(error);
        }
    };

    return (
        <div className="lazy-fade-in flex h-full w-full">

            {/* 左侧导航栏 */}
            <nav className="flex w-56 shrink-0 flex-col border-r border-border p-4">
                <h1 className="mb-4 px-2 text-lg font-bold tracking-tight text-foreground">{t("page_title")}</h1>
                <div className="flex flex-col gap-1">
                    {NAV_ITEMS.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveCategory(item.id)}
                            className={cn(
                                "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                                activeCategory === item.id
                                    ? "bg-accent text-accent-foreground"
                                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                            )}
                        >
                            <item.icon className="size-4 shrink-0" />
                            {t(item.labelKey)}
                        </button>
                    ))}
                </div>
            </nav>

            {/* 右侧内容区 */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">

                    {/* ============ 外观 ============ */}
                    {activeCategory === "appearance" && (
                        <SettingsCard title={t("preferences_title")}>
                            {/* 主题 */}
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

                            <div className="my-2 h-px w-full bg-border"/>

                            {/* 语言 */}
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

                            {/* 强调色 */}
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="font-medium text-foreground">{t("accent_color_label")}</span>
                                    <span className="text-xs text-muted-foreground">{t("accent_color_desc")}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    {ACCENT_PRESETS.map((preset) => {
                                        // monochrome: 深色主题用白色圆点，浅色主题用黑色圆点
                                        const isDark = document.documentElement.classList.contains("dark");
                                        const bgColor = preset.colorDark && isDark ? preset.colorDark : preset.color;
                                        return (
                                            <button
                                                key={preset.value}
                                                onClick={() => handleAccentChange(preset.value)}
                                                className={cn(
                                                    "size-7 rounded-full transition-all hover:scale-110",
                                                    accentColor === preset.value
                                                        ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                                                        : "ring-1 ring-border"
                                                )}
                                                style={{backgroundColor: bgColor}}
                                                title={preset.label}
                                                aria-label={preset.label}
                                            />
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="my-2 h-px w-full bg-border"/>

                            {/* 密度 */}
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="font-medium text-foreground">{t("density_label")}</span>
                                    <span className="text-xs text-muted-foreground">{t("density_desc")}</span>
                                </div>
                                <div className="flex items-center gap-1 rounded-lg border border-border p-1">
                                    {SPACINESS_PRESETS.map((preset) => (
                                        <button
                                            key={preset.value}
                                            onClick={() => handleSpacinessChange(preset.value)}
                                            className={cn(
                                                "cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-all",
                                                spaciness === preset.value
                                                    ? "bg-primary text-primary-foreground"
                                                    : "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            {preset.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="my-2 h-px w-full bg-border"/>

                            {/* 终端配色联动 */}
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="font-medium text-foreground">{t("terminal_color_link_label")}</span>
                                    <span className="text-xs text-muted-foreground">{t("terminal_color_link_desc")}</span>
                                </div>
                                <button
                                    role="switch"
                                    aria-checked={terminalColorLink}
                                    onClick={() => handleTerminalColorLinkChange(!terminalColorLink)}
                                    className={cn(
                                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center",
                                        "rounded-full border-2 border-transparent transition-colors",
                                        terminalColorLink ? "bg-primary" : "bg-muted"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "pointer-events-none block size-5 rounded-full bg-background shadow-lg",
                                            "transition-transform",
                                            terminalColorLink ? "translate-x-5" : "translate-x-0"
                                        )}
                                    />
                                </button>
                            </div>
                        </SettingsCard>
                    )}

                    {/* ============ 终端 ============ */}
                    {activeCategory === "terminal" && (
                        <SettingsCard title={t("log_section_title")}>
                            <LogViewer/>
                        </SettingsCard>
                    )}

                    {/* ============ 同步 ============ */}
                    {activeCategory === "sync" && (
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
                    )}

                    {/* ============ 安全 ============ */}
                    {activeCategory === "security" && (
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
                    )}

                    {/* ============ 关于 ============ */}
                    {activeCategory === "about" && (
                        <SettingsCard title={t("about_title")} description={t("about_desc")}>
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="font-medium text-foreground">{t("check_update_title")}</span>
                                    <span className="text-xs text-muted-foreground">{t("check_update_desc")}</span>
                                </div>
                                <Button
                                    variant="outline"
                                    onClick={handleCheckUpdate}
                                    disabled={isCheckingUpdate}
                                >
                                    {isCheckingUpdate ? (
                                        <Loader2 className="mr-2 size-4 animate-spin"/>
                                    ) : (
                                        <Download className="mr-2 size-4"/>
                                    )}
                                    {isCheckingUpdate ? t("checking", {ns: "common"}) : t("check_update_btn")}
                                </Button>
                            </div>

                            {/* 检查结果 */}
                            {releaseInfo && (
                                <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
                                    {releaseInfo.hasUpdate ? (
                                        <>
                                            <div className="mb-2 flex items-center gap-2">
                                                <Download className="size-4 text-primary"/>
                                                <span className="font-semibold text-primary">
                                                    {t("new_version_available", {version: releaseInfo.latestVersion})}
                                                </span>
                                            </div>
                                            <p className="mb-2 text-xs text-muted-foreground">
                                                {t("current_version", {version: releaseInfo.currentVersion})}
                                            </p>
                                            {releaseInfo.publishedAt && (
                                                <p className="mb-2 text-xs text-muted-foreground">
                                                    {t("published_at", {date: new Date(releaseInfo.publishedAt).toLocaleDateString()})}
                                                </p>
                                            )}
                                            <Button size="sm" variant="outline" onClick={handleOpenReleasePage} className="mt-2">
                                                <ExternalLink className="mr-2 size-3"/>
                                                {t("go_to_download")}
                                            </Button>
                                        </>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 className="size-4 text-green-500"/>
                                            <span className="text-sm text-foreground">
                                                {t("already_latest", {version: releaseInfo.currentVersion})}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </SettingsCard>
                    )}

                </div>
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
