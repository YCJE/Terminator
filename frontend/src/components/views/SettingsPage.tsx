import { useState, useEffect } from "react";
import { Events } from "@wailsio/runtime";
import { AppEvent } from "@/lib/events";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { User, Server, Lock, Trash2, AlertTriangle, Palette, Moon, Sun, Unplug, ScrollText, Download, ExternalLink, Loader2, CheckCircle2, Info, Keyboard, ShieldCheck, Plus, RotateCw, Camera, Play, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SwitchServerModal } from "@/components/views/SwitchServerModal";
import { WebDAVModal } from "@/components/views/WebDAVModal";
import { SyncConflictPanel } from "@/components/views/SyncConflictPanel";
import { KnownHostsPanel } from "@/components/views/KnownHostsPanel";
import { BackupPanel } from "@/components/views/BackupPanel";
import { LogViewer } from "@/components/views/LogViewer";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SettingsCard, SettingsRow, SettingsSwitch, SettingsSegmented } from "@/components/ui/settings-card";
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
import { useUIStore, Theme, ACCENT_PRESETS, SPACINESS_PRESETS, SKIN_PRESETS, type AccentColor, type Spaciness, type Skin, type SettingsCategory } from "@/store/uiStore.ts";
import { HIGHLIGHT_COLORS } from "@/lib/highlightRules";
import {
    comboFromEvent,
    comboLabel,
    combosEqual,
    SHORTCUT_DEFS,
    DEFAULT_SHORTCUTS,
    setShortcutRecording,
    type ShortcutId,
    type ShortcutCombo,
} from "@/lib/shortcuts";
import { applyTerminalColorLink } from "@/lib/terminalTheme";
import {
    captureCurrentLayout,
    loadSessionSnapshots,
    openSessionSnapshot,
    saveSessionSnapshots,
    type SessionSnapshot,
} from "@/lib/sessionSnapshots";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const NAV_ITEMS: { id: SettingsCategory; labelKey: string; icon: LucideIcon }[] = [
    { id: "appearance", labelKey: "nav_appearance", icon: Palette },
    { id: "terminal", labelKey: "nav_terminal", icon: ScrollText },
    { id: "shortcuts", labelKey: "nav_shortcuts", icon: Keyboard },
    { id: "sync", labelKey: "nav_sync", icon: Server },
    { id: "security", labelKey: "nav_security", icon: Lock },
    { id: "about", labelKey: "nav_about", icon: Download },
];

/** 不可自定义的固定快捷键（可自定义项见 SHORTCUT_DEFS） */
const TERMINAL_SHORTCUTS: { keys: string; labelKey: string }[] = [
    { keys: "Ctrl+Shift+C", labelKey: "shortcut_copy" },
    { keys: "Ctrl+Shift+V", labelKey: "shortcut_paste" },
    { keys: "Esc", labelKey: "shortcut_close_search" },
];

const TAB_SHORTCUTS: { keys: string; labelKey: string }[] = [
    { keys: "Enter", labelKey: "shortcut_tab_activate" },
    { keys: "Drag", labelKey: "shortcut_tab_reorder" },
    { keys: "Right-Click", labelKey: "shortcut_tab_color" },
];

/** 终端内硬编码的复制/粘贴组合：不允许被可配置动作占用，否则会互相吞掉按键 */
const RESERVED_SHORTCUTS: ShortcutCombo[] = [
    { ctrl: true, alt: false, shift: true, code: "KeyC" },
    { ctrl: true, alt: false, shift: true, code: "KeyV" },
];

/** 仅正则规则需要校验；非法表达式在设置页标红并跳过应用 */
function isInvalidRegex(pattern: string, regex: boolean): boolean {
    if (!regex || !pattern) return false;
    try {
        new RegExp(pattern);
        return false;
    } catch {
        return true;
    }
}

export function SettingsPage() {
    const {t, i18n} = useTranslation(["settings", "common", "errors"]);
    const {data: user, refetch} = useCurrentUser();
    const {setUnlocked, setHasUser} = useAuthStore();
    const {clearSessions} = useSessionStore();
    const {lastError} = useSyncStore();
    const {
        theme, setTheme, accentColor, setAccentColor, spaciness, setSpaciness, skin, setSkin,
        terminalColorLink, setTerminalColorLink, keywordHighlight, setKeywordHighlight,
        broadcastEnabled, toggleBroadcastEnabled, tabColorEnabled, toggleTabColorEnabled,
        pasteProtection, setPasteProtection, autoReconnect, setAutoReconnect,
        sftpFollowCwd, setSftpFollowCwd,
        workspaceRestore, setWorkspaceRestore,
        highlightRules, addHighlightRule, updateHighlightRule, removeHighlightRule,
        completionNotify, setCompletionNotify,
        shortcuts, setShortcut, resetShortcut, resetAllShortcuts,
    } = useUIStore();
    const queryClient = useQueryClient();

    // 快捷键录制：按下组合键后写入 store，冲突或缺少修饰键时给出提示
    const [recordingShortcut, setRecordingShortcut] = useState<ShortcutId | null>(null);
    const [shortcutError, setShortcutError] = useState("");

    useEffect(() => {
        if (!recordingShortcut) return;
        const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === "Escape") {
                setRecordingShortcut(null);
                setShortcutError("");
                return;
            }
            const combo = comboFromEvent(e);
            if (!combo) {
                setShortcutError(t("shortcut_need_modifier"));
                return;
            }
            // 与终端内固定的复制/粘贴冲突：该按键会被固定逻辑先消费，
            // 录制出来的动作永远不会触发，直接拒绝并提示。
            if (RESERVED_SHORTCUTS.some((reserved) => combosEqual(reserved, combo))) {
                setShortcutError(t("shortcut_reserved"));
                return;
            }
            const conflict = SHORTCUT_DEFS.find(
                (def) => def.id !== recordingShortcut && combosEqual(shortcuts[def.id], combo),
            );
            if (conflict) {
                setShortcutError(t("shortcut_conflict", {name: t(conflict.labelKey)}));
                return;
            }
            setShortcut(recordingShortcut, combo);
            setRecordingShortcut(null);
            setShortcutError("");
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [recordingShortcut, shortcuts, setShortcut, t]);

    // 录制期间暂停其他全局快捷键的响应，避免按键被命令面板等动作抢占
    useEffect(() => {
        setShortcutRecording(!!recordingShortcut);
        return () => setShortcutRecording(false);
    }, [recordingShortcut]);

    const {settingsCategory: activeCategory, setSettingsCategory: setActiveCategory} = useUIStore();
    // 皮肤对明暗有强制语义（HUD 恒暗、编辑纸感恒亮），色板预览必须与 App 的
    // effectiveDark 保持一致，否则在「浅色主题 + HUD」下会显示浅色版色块。
    const effectiveDark = skin === "hud" ? true : skin === "editorial" ? false : theme === "dark";
    const [isServerModalOpen, setIsServerModalOpen] = useState(false);
    const [isWipeModalOpen, setIsWipeModalOpen] = useState(false);
    const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);
    const [isWebDAVModalOpen, setIsWebDAVModalOpen] = useState(false);
    const [syncMethod, setSyncMethod] = useState<string>("server");
    const [webdavUrl, setWebdavUrl] = useState<string>("");
    const [sessionLogEnabled, setSessionLogEnabled] = useState(false);
    const [sessionLogRetentionDays, setSessionLogRetentionDays] = useState(7);

    // 会话快照：命名保存当前标签组与分屏布局
    const [snapshots, setSnapshots] = useState<SessionSnapshot[]>([]);
    const [snapshotName, setSnapshotName] = useState("");
    const [openingSnapshotId, setOpeningSnapshotId] = useState<string | null>(null);

    useEffect(() => {
        setSnapshots(loadSessionSnapshots());
    }, []);

    const handleSaveSnapshot = () => {
        const name = snapshotName.trim();
        if (!name) {
            toast.error(t("snapshot_name_required"));
            return;
        }
        const layout = captureCurrentLayout();
        if (layout.sessions.length === 0) {
            toast.error(t("snapshot_empty_workspace"));
            return;
        }
        const next = [
            {id: crypto.randomUUID(), name, ...layout, savedAt: Date.now()},
            ...snapshots,
        ];
        setSnapshots(next);
        saveSessionSnapshots(next);
        setSnapshotName("");
        toast.success(t("snapshot_saved", {name}));
    };

    const handleOverwriteSnapshot = (snapshot: SessionSnapshot) => {
        const layout = captureCurrentLayout();
        if (layout.sessions.length === 0) {
            toast.error(t("snapshot_empty_workspace"));
            return;
        }
        const next = snapshots.map((item) => item.id === snapshot.id
            ? {...item, ...layout, savedAt: Date.now()}
            : item);
        setSnapshots(next);
        saveSessionSnapshots(next);
        toast.success(t("snapshot_overwritten", {name: snapshot.name}));
    };

    const handleOpenSnapshot = async (snapshot: SessionSnapshot) => {
        setOpeningSnapshotId(snapshot.id);
        try {
            const count = await openSessionSnapshot(snapshot);
            if (count === 0) {
                toast.error(t("snapshot_none_available"));
            } else {
                toast.success(t("snapshot_opened", {count}));
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setOpeningSnapshotId(null);
        }
    };

    const handleDeleteSnapshot = (snapshot: SessionSnapshot) => {
        const next = snapshots.filter((item) => item.id !== snapshot.id);
        setSnapshots(next);
        saveSessionSnapshots(next);
        toast.success(t("snapshot_deleted", {name: snapshot.name}));
    };
    // 更新检查状态
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [releaseInfo, setReleaseInfo] = useState<GitHubReleaseInfo | null>(null);
    // 下载并校验状态
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadPercent, setDownloadPercent] = useState(0);
    const [verifiedPath, setVerifiedPath] = useState("");

    // 读取当前同步方式
    useEffect(() => {
        SettingsService.GetSettings()
            .then((s) => {
                setSyncMethod(s.sync_method || "server");
                setWebdavUrl(s.webdav_url || "");
                setSessionLogEnabled(s.session_log_enabled);
                setSessionLogRetentionDays(s.session_log_retention_days || 7);
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

    // 手动下载安装包时后端会持续上报进度百分比
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.UpdaterProgress, (event) => {
            const percent = event?.data;
            if (typeof percent === "number") {
                setDownloadPercent(percent);
            }
        });
        return () => unsubscribe();
    }, []);

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
            // ConfirmModal 的确认按钮会 preventDefault，不会自动关闭；
            // 成功后才关闭，失败时保持打开以便用户重试
            setIsDisconnectModalOpen(false);
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

    // 下载安装包并在后端校验 SHA256，校验失败会返回错误且不落地文件
    const handleDownloadAndVerify = async () => {
        setIsDownloading(true);
        setDownloadPercent(0);
        setVerifiedPath("");
        try {
            setVerifiedPath(await UpdaterService.DownloadAndVerifyUpdate());
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleOpenVerified = async () => {
        try {
            await UpdaterService.OpenVerifiedDownload();
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
            await i18n.changeLanguage(lng);
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

    // 皮肤切换：data-skin 由 App 的 effect 统一下发，这里只改状态并持久化
    const handleSkinChange = async (next: Skin) => {
        const prev = skin;
        try {
            setSkin(next);
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                skin: next,
            }));
        } catch (error) {
            setSkin(prev);
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

    const handleSessionLogToggle = async (enabled: boolean) => {
        const prev = sessionLogEnabled;
        try {
            setSessionLogEnabled(enabled);
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                session_log_enabled: enabled,
            }));
        } catch (error) {
            setSessionLogEnabled(prev);
            handleAppError(error);
        }
    };

    const handleSessionLogRetentionChange = async (days: string) => {
        const value = Number(days);
        const prev = sessionLogRetentionDays;
        try {
            setSessionLogRetentionDays(value);
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                session_log_retention_days: value,
            }));
        } catch (error) {
            setSessionLogRetentionDays(prev);
            handleAppError(error);
        }
    };

    return (
        <div className="lazy-fade-in flex h-full w-full">

            {/* 左侧分类导航 */}
            <nav className="flex w-52 shrink-0 flex-col border-r border-[var(--hairline)]">
                <h1 className="px-5 pt-5 pb-3 text-[13px] font-semibold tracking-tight text-[var(--fg-strong)]">
                    {t("page_title")}
                </h1>
                <div className="settings-nav">
                    {NAV_ITEMS.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveCategory(item.id)}
                            className={cn("settings-nav-item", activeCategory === item.id && "is-active")}
                        >
                            <item.icon className="size-3.5 shrink-0"/>
                            {t(item.labelKey)}
                        </button>
                    ))}
                </div>
            </nav>

            {/* 右侧内容区 */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-8 py-6">

                    {/* ============ 外观 ============ */}
                    {activeCategory === "appearance" && (
                        <SettingsCard title={t("preferences_title")}>
                            <SettingsRow
                                title={t("theme_label")}
                                desc={skin !== "default" ? t("theme_overridden_by_skin") : undefined}
                            >
                                <Select value={theme} onValueChange={(v) => changeTheme(v as Theme)}
                                        disabled={skin !== "default"}>
                                    <SelectTrigger className="settings-control w-40 text-[12.5px]">
                                        <SelectValue placeholder={t("select_theme")}/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="dark">
                                            <span className="flex items-center gap-2">
                                                <Moon className="size-3.5"/>
                                                {t("theme_dark")}
                                            </span>
                                        </SelectItem>
                                        <SelectItem value="light">
                                            <span className="flex items-center gap-2">
                                                <Sun className="size-3.5"/>
                                                {t("theme_light")}
                                            </span>
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>

                            <SettingsRow title={t("skin_label")} desc={t("skin_desc")}>
                                <SettingsSegmented
                                    value={skin}
                                    onChange={handleSkinChange}
                                    options={SKIN_PRESETS.map((preset) => ({
                                        value: preset.value,
                                        label: t(preset.labelKey),
                                    }))}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("language_label")}>
                                <Select
                                    value={(i18n.resolvedLanguage ?? i18n.language)?.startsWith("zh") ? "zh" : "en"}
                                    onValueChange={changeLanguage}
                                >
                                    <SelectTrigger className="settings-control w-40 text-[12.5px]">
                                        <SelectValue placeholder={t("select_language")}/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="en">English</SelectItem>
                                        <SelectItem value="zh">中文</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>

                            <SettingsRow title={t("accent_color_label")} desc={t("accent_color_desc")}>
                                <div className="flex items-center gap-2">
                                    {ACCENT_PRESETS.map((preset) => {
                                        // 使用有效的明暗状态（皮肤优先）而非原始 theme，
                                        // 确保强调色预设的深浅变体与当前皮肤匹配
                                        const isDark = effectiveDark;
                                        const bgColor = preset.colorDark && isDark ? preset.colorDark : preset.color;
                                        return (
                                            <button
                                                key={preset.value}
                                                onClick={() => handleAccentChange(preset.value)}
                                                className={cn(
                                                    "size-6 rounded-full transition-all hover:scale-110",
                                                    accentColor === preset.value
                                                        ? "ring-2 ring-[var(--fg-strong)] ring-offset-2 ring-offset-[var(--surface-1)]"
                                                        : "ring-1 ring-[var(--hairline-strong)]"
                                                )}
                                                style={{backgroundColor: bgColor}}
                                                title={t(preset.labelKey)}
                                                aria-label={t(preset.labelKey)}
                                            />
                                        );
                                    })}
                                </div>
                            </SettingsRow>

                            <SettingsRow title={t("density_label")} desc={t("density_desc")}>
                                <SettingsSegmented
                                    value={spaciness}
                                    onChange={handleSpacinessChange}
                                    options={SPACINESS_PRESETS.map((preset) => ({
                                        value: preset.value,
                                        label: t(preset.labelKey),
                                    }))}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("terminal_color_link_label")} desc={t("terminal_color_link_desc")}>
                                <SettingsSwitch
                                    checked={terminalColorLink}
                                    onChange={handleTerminalColorLinkChange}
                                    label={t("terminal_color_link_label")}
                                />
                            </SettingsRow>
                        </SettingsCard>
                    )}

                    {/* ============ 终端 ============ */}
                    {activeCategory === "terminal" && (
                        <>
                        <SettingsCard title={t("terminal_features_title")} description={t("terminal_features_desc")}>
                            <SettingsRow title={t("keyword_highlight_label")} desc={t("keyword_highlight_desc")}>
                                <SettingsSwitch
                                    checked={keywordHighlight}
                                    onChange={setKeywordHighlight}
                                    label={t("keyword_highlight_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("broadcast_label")} desc={t("broadcast_desc")}>
                                <SettingsSwitch
                                    checked={broadcastEnabled}
                                    onChange={() => toggleBroadcastEnabled()}
                                    label={t("broadcast_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("tab_color_label")} desc={t("tab_color_desc")}>
                                <SettingsSwitch
                                    checked={tabColorEnabled}
                                    onChange={() => toggleTabColorEnabled()}
                                    label={t("tab_color_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("paste_protection_label")} desc={t("paste_protection_desc")}>
                                <SettingsSwitch
                                    checked={pasteProtection}
                                    onChange={setPasteProtection}
                                    label={t("paste_protection_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("auto_reconnect_label")} desc={t("auto_reconnect_desc")}>
                                <SettingsSwitch
                                    checked={autoReconnect}
                                    onChange={setAutoReconnect}
                                    label={t("auto_reconnect_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("sftp_follow_cwd_label")} desc={t("sftp_follow_cwd_desc")}>
                                <SettingsSwitch
                                    checked={sftpFollowCwd}
                                    onChange={setSftpFollowCwd}
                                    label={t("sftp_follow_cwd_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("workspace_restore_label")} desc={t("workspace_restore_desc")}>
                                <SettingsSwitch
                                    checked={workspaceRestore}
                                    onChange={setWorkspaceRestore}
                                    label={t("workspace_restore_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("completion_notify_label")} desc={t("completion_notify_desc")}>
                                <SettingsSwitch
                                    checked={completionNotify}
                                    onChange={setCompletionNotify}
                                    label={t("completion_notify_label")}
                                />
                            </SettingsRow>
                        </SettingsCard>

                        <SettingsCard title={t("highlight_rules_title")} description={t("highlight_rules_desc")}>
                            {highlightRules.length === 0 ? (
                                <div className="px-4 py-3 text-xs text-[var(--fg-muted)]">
                                    {t("highlight_rules_empty")}
                                </div>
                            ) : (
                                highlightRules.map((rule) => {
                                    const invalid = isInvalidRegex(rule.pattern, rule.regex);
                                    return (
                                        <div
                                            key={rule.id}
                                            className="flex flex-wrap items-center gap-2 border-t border-[var(--hairline)] px-4 py-2"
                                        >
                                            <Input
                                                value={rule.pattern}
                                                onChange={(e) => updateHighlightRule(rule.id, {pattern: e.target.value})}
                                                placeholder={rule.regex
                                                    ? t("highlight_pattern_regex")
                                                    : t("highlight_pattern_literal")}
                                                title={invalid ? t("highlight_invalid_regex") : undefined}
                                                className={cn(
                                                    "h-8 min-w-40 flex-1 font-mono text-xs",
                                                    invalid && "border-destructive"
                                                )}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => updateHighlightRule(rule.id, {regex: !rule.regex})}
                                                title={t("highlight_regex_hint")}
                                                className={cn(
                                                    "shrink-0 rounded-[var(--radius-sm)] border px-2 py-1 text-[10.5px] transition-colors",
                                                    rule.regex
                                                        ? "border-[var(--hairline-strong)] bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                                        : "border-[var(--hairline)] text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                                                )}
                                            >
                                                {t("highlight_regex")}
                                            </button>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {HIGHLIGHT_COLORS.map((color) => (
                                                    <button
                                                        key={color.value}
                                                        type="button"
                                                        onClick={() => updateHighlightRule(rule.id, {color: color.value})}
                                                        title={t(color.labelKey)}
                                                        aria-label={t(color.labelKey)}
                                                        className={cn(
                                                            "size-4 rounded-full ring-1 ring-[var(--hairline-strong)] transition-transform hover:scale-110",
                                                            rule.color === color.value && "ring-2 ring-[var(--fg-strong)]"
                                                        )}
                                                        style={{backgroundColor: color.hex}}
                                                    />
                                                ))}
                                            </div>
                                            <SettingsSwitch
                                                checked={rule.enabled}
                                                onChange={(enabled) => updateHighlightRule(rule.id, {enabled})}
                                                label={t("highlight_enabled")}
                                            />
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => removeHighlightRule(rule.id)}
                                                title={t("highlight_remove")}
                                            >
                                                <Trash2 className="size-3.5"/>
                                            </Button>
                                        </div>
                                    );
                                })
                            )}
                            <div className="border-t border-[var(--hairline)] px-4 py-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => addHighlightRule({
                                        pattern: "",
                                        regex: false,
                                        color: "yellow",
                                        enabled: true,
                                    })}
                                >
                                    <Plus className="mr-1.5 size-3.5"/>
                                    {t("highlight_add_rule")}
                                </Button>
                            </div>
                        </SettingsCard>

                        <SettingsCard title={t("snapshots_title")} description={t("snapshots_desc")}>
                            <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-3">
                                <Input
                                    value={snapshotName}
                                    onChange={(e) => setSnapshotName(e.target.value)}
                                    placeholder={t("snapshot_name_placeholder")}
                                    className="h-8 flex-1 text-xs"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSaveSnapshot();
                                    }}
                                />
                                <Button variant="outline" size="sm" onClick={handleSaveSnapshot}>
                                    <Camera className="mr-1.5 size-3.5"/>
                                    {t("snapshot_save")}
                                </Button>
                            </div>
                            {snapshots.length === 0 ? (
                                <div className="px-4 py-3 text-xs text-[var(--fg-muted)]">
                                    {t("snapshots_empty")}
                                </div>
                            ) : (
                                snapshots.map((snapshot) => (
                                    <div
                                        key={snapshot.id}
                                        className="flex flex-wrap items-center gap-2 border-t border-[var(--hairline)] px-4 py-2"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[12.5px] font-medium text-[var(--fg-strong)]">
                                                {snapshot.name}
                                            </div>
                                            <div className="text-[10.5px] text-[var(--fg-subtle)]">
                                                {t("snapshot_meta", {
                                                    count: snapshot.sessions.length,
                                                    date: new Date(snapshot.savedAt).toLocaleString(),
                                                })}
                                            </div>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleOpenSnapshot(snapshot)}
                                            disabled={openingSnapshotId !== null}
                                        >
                                            {openingSnapshotId === snapshot.id
                                                ? <Loader2 className="mr-1.5 size-3.5 animate-spin"/>
                                                : <Play className="mr-1.5 size-3.5"/>}
                                            {t("snapshot_open")}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            onClick={() => handleOverwriteSnapshot(snapshot)}
                                            title={t("snapshot_overwrite")}
                                        >
                                            <Camera className="size-3.5"/>
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            onClick={() => handleDeleteSnapshot(snapshot)}
                                            title={t("snapshot_delete")}
                                        >
                                            <Trash2 className="size-3.5"/>
                                        </Button>
                                    </div>
                                ))
                            )}
                        </SettingsCard>

                        {/* Agent 转发和代理说明 */}
                        <div className="callout">
                            <Info className="mt-0.5 size-3.5 shrink-0"/>
                            <span>{t("agent_forwarding_info")}</span>
                        </div>

                        <SettingsCard title={t("session_log_title")} description={t("session_log_desc")}>
                            <SettingsRow title={t("session_log_enable_label")} desc={t("session_log_enable_desc")}>
                                <SettingsSwitch
                                    checked={sessionLogEnabled}
                                    onChange={handleSessionLogToggle}
                                    label={t("session_log_enable_label")}
                                />
                            </SettingsRow>

                            {/* 保留期仅在开启时可调 */}
                            {sessionLogEnabled && (
                                <SettingsRow title={t("session_log_retention_label")} desc={t("session_log_retention_desc")}>
                                    <Select
                                        value={String(sessionLogRetentionDays)}
                                        onValueChange={handleSessionLogRetentionChange}
                                    >
                                        <SelectTrigger className="settings-control w-40 text-[12.5px]">
                                            <SelectValue/>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {[1, 7, 30, 90].map((days) => (
                                                <SelectItem key={days} value={String(days)}>
                                                    {t("session_log_days", {count: days})}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingsRow>
                            )}

                            <div className="callout mx-4 mb-3">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
                                <span>{t("session_log_warning")}</span>
                            </div>
                        </SettingsCard>

                        <SettingsCard title={t("log_section_title")}>
                            <LogViewer/>
                        </SettingsCard>
                        </>
                    )}

                    {/* ============ 同步 ============ */}
                    {activeCategory === "sync" && (
                        <>
                        <SettingsCard title={t("profile_sync_title")} description={t("profile_sync_desc")}>
                            {/* 账户信息 */}
                            <div className="flex items-center gap-3 px-4 py-3.5">
                                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                    <User className="size-4"/>
                                </div>
                                <div className="flex min-w-0 flex-col">
                                    <span className="text-[11.5px] text-[var(--fg-subtle)]">
                                        {t("username", {ns: "common"})}
                                    </span>
                                    <span className="truncate text-[14px] font-semibold text-[var(--fg-strong)]">
                                        {user?.username || t("loading", {ns: "common"})}
                                    </span>
                                </div>
                            </div>

                            {lastError && (
                                <div className="callout is-danger mx-4 mb-3">
                                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
                                    <div className="flex min-w-0 flex-col gap-0.5">
                                        <span className="text-[12px] font-medium">{t("sync_offline")}</span>
                                        <span className="text-[11px] opacity-90">
                                            {t(`errors:${lastError.code}`, {defaultValue: lastError.message})}
                                        </span>
                                        {lastError.detailsString && (
                                            <span className="mt-0.5 break-all font-mono text-[10.5px] opacity-75">
                                                {lastError.detailsString}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* 服务器同步 */}
                            <SettingsRow
                                title={t("sync_server_title")}
                                desc={syncMethod === "server" && user?.serverUrl
                                    ? user.serverUrl
                                    : t("sync_server_desc")}
                            >
                                {syncMethod === "server" && user?.serverUrl && (
                                    <Button variant="ghost" size="sm" onClick={() => setIsDisconnectModalOpen(true)}>
                                        <Unplug className="mr-1.5 size-3.5"/>
                                        {t("disconnect_btn")}
                                    </Button>
                                )}
                                <Button
                                    variant={syncMethod === "server" ? "secondary" : "outline"}
                                    className="settings-control"
                                    onClick={() => setIsServerModalOpen(true)}
                                >
                                    {user?.serverUrl ? t("switch_server_btn") : t("connect_btn")}
                                </Button>
                            </SettingsRow>

                            {/* WebDAV 同步 */}
                            <SettingsRow
                                title={t("webdav_title")}
                                desc={syncMethod === "webdav" && webdavUrl
                                    ? webdavUrl
                                    : t("webdav_card_desc")}
                            >
                                <Button
                                    variant={syncMethod === "webdav" ? "secondary" : "outline"}
                                    className="settings-control"
                                    onClick={() => setIsWebDAVModalOpen(true)}
                                >
                                    {syncMethod === "webdav" ? t("webdav_edit_btn") : t("webdav_setup_btn")}
                                </Button>
                            </SettingsRow>
                        </SettingsCard>

                        <SyncConflictPanel/>
                        </>
                    )}

                    {/* ============ 安全 ============ */}
                    {activeCategory === "security" && (
                        <>
                        <SettingsCard title={t("security_title")} description={t("security_desc")}>
                            <SettingsRow title={t("lock_vault_title")} desc={t("lock_vault_desc")}>
                                <Button variant="outline" className="settings-control" onClick={handleLockVault}>
                                    <Lock className="mr-1.5 size-3.5"/>
                                    {t("lock_btn")}
                                </Button>
                            </SettingsRow>

                            <SettingsRow title={t("wipe_data_title")} desc={t("wipe_data_desc")} danger>
                                <Button variant="destructive" className="settings-control"
                                        onClick={() => setIsWipeModalOpen(true)}>
                                    <Trash2 className="mr-1.5 size-3.5"/>
                                    {t("wipe_btn")}
                                </Button>
                            </SettingsRow>
                        </SettingsCard>

                        <KnownHostsPanel/>

                        <BackupPanel/>
                        </>
                    )}

                    {/* ============ 快捷键 ============ */}
                    {activeCategory === "shortcuts" && (
                        <SettingsCard title={t("shortcuts_title")} description={t("shortcuts_desc")}>
                            <div className="settings-group-label flex items-center justify-between">
                                <span>{t("shortcuts_terminal")}</span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShortcutError("");
                                        resetAllShortcuts();
                                    }}
                                    className="text-xs text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--fg-strong)] hover:underline"
                                >
                                    {t("shortcut_reset_all")}
                                </button>
                            </div>
                            {SHORTCUT_DEFS.map((def) => {
                                const isRecording = recordingShortcut === def.id;
                                const modified = !combosEqual(shortcuts[def.id], DEFAULT_SHORTCUTS[def.id]);
                                return (
                                    <div key={def.id} className="settings-row">
                                        <span className="settings-row-title">{t(def.labelKey)}</span>
                                        <div className="settings-row-control flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setRecordingShortcut(isRecording ? null : def.id);
                                                    setShortcutError("");
                                                }}
                                                className={cn(
                                                    "kbd-key cursor-pointer transition-colors",
                                                    isRecording && "border-[var(--accent)] text-[var(--fg-strong)]"
                                                )}
                                                title={t("shortcut_edit_hint")}
                                            >
                                                {isRecording ? t("shortcut_press_keys") : comboLabel(shortcuts[def.id])}
                                            </button>
                                            {modified && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setShortcutError("");
                                                        resetShortcut(def.id);
                                                    }}
                                                    className="flex size-5 items-center justify-center rounded-sm text-[var(--fg-subtle)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                                                    title={t("shortcut_reset")}
                                                    aria-label={t("shortcut_reset")}
                                                >
                                                    <RotateCw className="size-3.5"/>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {shortcutError && (
                                <div className="px-4 pb-2 text-xs text-[var(--destructive)]">{shortcutError}</div>
                            )}

                            <div className="settings-group-label">{t("shortcuts_fixed")}</div>
                            {TERMINAL_SHORTCUTS.map((item) => (
                                <div key={item.keys} className="settings-row">
                                    <span className="settings-row-title">{t(item.labelKey)}</span>
                                    <div className="settings-row-control">
                                        <kbd className="kbd-key">{item.keys}</kbd>
                                    </div>
                                </div>
                            ))}

                            <div className="settings-group-label">{t("shortcuts_tabs")}</div>
                            {TAB_SHORTCUTS.map((item) => (
                                <div key={item.keys} className="settings-row">
                                    <span className="settings-row-title">{t(item.labelKey)}</span>
                                    <div className="settings-row-control">
                                        <kbd className="kbd-key">{item.keys}</kbd>
                                    </div>
                                </div>
                            ))}
                        </SettingsCard>
                    )}

                    {/* ============ 关于 ============ */}
                    {activeCategory === "about" && (
                        <SettingsCard title={t("about_title")} description={t("about_desc")}>
                            <SettingsRow title={t("check_update_title")} desc={t("check_update_desc")}>
                                <Button
                                    variant="outline"
                                    className="settings-control"
                                    onClick={handleCheckUpdate}
                                    disabled={isCheckingUpdate}
                                >
                                    {isCheckingUpdate ? (
                                        <Loader2 className="mr-1.5 size-3.5 animate-spin"/>
                                    ) : (
                                        <Download className="mr-1.5 size-3.5"/>
                                    )}
                                    {isCheckingUpdate ? t("checking", {ns: "common"}) : t("check_update_btn")}
                                </Button>
                            </SettingsRow>

                            {/* 检查结果 */}
                            {releaseInfo && (
                                <div className="mx-4 mb-4 rounded-[var(--radius-md)] border border-[var(--hairline)]
                                                bg-[var(--surface-2)] p-3.5">
                                    {releaseInfo.hasUpdate ? (
                                        <>
                                            <div className="mb-2 flex items-center gap-2">
                                                <Download className="size-4 text-primary"/>
                                                <span className="text-[13px] font-semibold text-primary">
                                                    {t("new_version_available", {version: releaseInfo.latestVersion})}
                                                </span>
                                            </div>
                                            <p className="text-[11.5px] text-[var(--fg-subtle)]">
                                                {t("current_version", {version: releaseInfo.currentVersion})}
                                            </p>
                                            {releaseInfo.publishedAt && (
                                                <p className="mt-0.5 text-[11.5px] text-[var(--fg-subtle)]">
                                                    {t("published_at", {date: new Date(releaseInfo.publishedAt).toLocaleDateString()})}
                                                </p>
                                            )}
                                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                                <Button size="sm" onClick={handleDownloadAndVerify} disabled={isDownloading}>
                                                    {isDownloading ? (
                                                        <Loader2 className="mr-1.5 size-3 animate-spin"/>
                                                    ) : (
                                                        <Download className="mr-1.5 size-3"/>
                                                    )}
                                                    {isDownloading
                                                        ? t("downloading_verified", {percent: downloadPercent})
                                                        : t("download_and_verify")}
                                                </Button>
                                                <Button size="sm" variant="outline" onClick={handleOpenReleasePage}>
                                                    <ExternalLink className="mr-1.5 size-3"/>
                                                    {t("go_to_download")}
                                                </Button>
                                            </div>

                                            {isDownloading && (
                                                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
                                                    <div
                                                        className="h-full bg-primary transition-all"
                                                        style={{width: `${downloadPercent}%`}}
                                                    />
                                                </div>
                                            )}

                                            {verifiedPath && (
                                                <div className="callout is-success mt-3">
                                                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0"/>
                                                    <div className="flex min-w-0 flex-col gap-1">
                                                        <span className="text-[11.5px] font-medium text-[var(--fg-strong)]">
                                                            {t("download_verified")}
                                                        </span>
                                                        <span className="break-all font-mono text-[11px]">
                                                            {verifiedPath}
                                                        </span>
                                                        <div>
                                                            <Button size="sm" variant="outline" onClick={handleOpenVerified}>
                                                                <ExternalLink className="mr-1.5 size-3"/>
                                                                {t("open_installer")}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 className="size-4 text-[var(--success)]"/>
                                            <span className="text-[13px] text-[var(--fg-strong)]">
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