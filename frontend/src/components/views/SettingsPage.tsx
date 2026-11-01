import { useState, useEffect } from "react";
import { Events } from "@wailsio/runtime";
import { AppEvent } from "@/lib/events";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { User, Server, Lock, Trash2, AlertTriangle, Palette, Moon, Sun, Unplug, ScrollText, Download, ExternalLink, Loader2, CheckCircle2, Info, Keyboard, ShieldCheck, Plus, RotateCw, Camera, Play, Power, ChevronLeft, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SwitchServerModal } from "@/components/views/SwitchServerModal";
import { WebDAVModal } from "@/components/views/WebDAVModal";
import { SyncConflictPanel } from "@/components/views/SyncConflictPanel";
import { KnownHostsPanel } from "@/components/views/KnownHostsPanel";
import { BackupPanel } from "@/components/views/BackupPanel";
import { LogViewer } from "@/components/views/LogViewer";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SettingsCard, SettingsRow, SettingsSwitch, SettingsSegmented, SettingsStepper } from "@/components/ui/settings-card";
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
import { useUIStore, Theme, ACCENT_PRESETS, SPACINESS_PRESETS, SKIN_PRESETS, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_LINE_HEIGHT_MIN, TERMINAL_LINE_HEIGHT_MAX, type AccentColor, type Spaciness, type Skin, type SettingsCategory } from "@/store/uiStore.ts";
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
import { applyTerminalColorLink, DEFAULT_TERMINAL_FONT_FAMILY, TERMINAL_COLOR_SCHEME_PRESETS, getTerminalSchemePreview, type TerminalColorScheme, type CustomTerminalColorKey } from "@/lib/terminalTheme";
import {
    captureCurrentLayout,
    loadSessionSnapshots,
    openSessionSnapshot,
    saveSessionSnapshots,
    type SessionSnapshot,
} from "@/lib/sessionSnapshots";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** 自定义配色的色块顺序：背景/前景/光标在前，随后是 ANSI 标准色与亮色 */
const CUSTOM_COLOR_ITEMS: { key: CustomTerminalColorKey; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "foreground", label: "Foreground" },
    { key: "cursor", label: "Cursor" },
    { key: "black", label: "Black" },
    { key: "red", label: "Red" },
    { key: "green", label: "Green" },
    { key: "yellow", label: "Yellow" },
    { key: "blue", label: "Blue" },
    { key: "magenta", label: "Magenta" },
    { key: "cyan", label: "Cyan" },
    { key: "white", label: "White" },
    { key: "brightBlack", label: "Bright Black" },
    { key: "brightRed", label: "Bright Red" },
    { key: "brightGreen", label: "Bright Green" },
    { key: "brightYellow", label: "Bright Yellow" },
    { key: "brightBlue", label: "Bright Blue" },
    { key: "brightMagenta", label: "Bright Magenta" },
    { key: "brightCyan", label: "Bright Cyan" },
    { key: "brightWhite", label: "Bright White" },
];

const NAV_GROUPS: { labelKey?: string; items: { id: SettingsCategory; labelKey: string; icon: LucideIcon }[] }[] = [
    {
        labelKey: "nav_group_preferences",
        items: [
            { id: "appearance", labelKey: "nav_appearance", icon: Palette },
            { id: "terminal", labelKey: "nav_terminal", icon: ScrollText },
            { id: "shortcuts", labelKey: "nav_shortcuts", icon: Keyboard },
        ],
    },
    {
        labelKey: "nav_group_data",
        items: [
            { id: "sync", labelKey: "nav_sync", icon: Server },
            { id: "security", labelKey: "nav_security", icon: Lock },
            { id: "system", labelKey: "nav_system", icon: Power },
        ],
    },
    {
        items: [
            { id: "about", labelKey: "nav_about", icon: Download },
        ],
    },
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
        commandSuggestions, setCommandSuggestions,
        monitorAlertsEnabled, setMonitorAlertsEnabled,
        monitorDesktopNotify, setMonitorDesktopNotify,
        monitorCpuThreshold, setMonitorCpuThreshold,
        monitorMemoryThreshold, setMonitorMemoryThreshold,
        monitorDiskThreshold, setMonitorDiskThreshold,
        monitorAlertStreak, setMonitorAlertStreak,
        workspaceRestore, setWorkspaceRestore,
        highlightRules, addHighlightRule, updateHighlightRule, removeHighlightRule,
        completionNotify, setCompletionNotify,
        terminalFontSize, setTerminalFontSize, terminalFontFamily, setTerminalFontFamily,
        terminalColorScheme, setTerminalColorScheme,
        customTerminalColors, setCustomTerminalColor, resetCustomTerminalColors,
        terminalCursorStyle, setTerminalCursorStyle, terminalCursorBlink, setTerminalCursorBlink,
        terminalLineHeight, setTerminalLineHeight, terminalScrollback, setTerminalScrollback,
        closeTabConfirm, setCloseTabConfirm,
        copyOnSelect, setCopyOnSelect,
        autoLockMinutes, setAutoLockMinutes,
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

    const {
        settingsCategory: activeCategory,
        settingsTarget,
        clearSettingsTarget,
        setSettingsCategory: setActiveCategory,
        exitSettings,
    } = useUIStore();
    // 皮肤对明暗有强制语义（HUD 恒暗、编辑纸感恒亮），色板预览必须与 App 的
    // effectiveDark 保持一致，否则在「浅色主题 + HUD」下会显示浅色版色块。
    const effectiveDark = skin === "hud" ? true : skin === "editorial" ? false : theme === "dark";
    // 命令面板定位：分类切换完成后滚动到目标行并短暂高亮
    useEffect(() => {
        if (!settingsTarget) return;
        const timer = setTimeout(() => {
            const target = document.getElementById(settingsTarget);
            if (target) {
                target.scrollIntoView({block: "center", behavior: "smooth"});
                target.classList.add("is-target");
                setTimeout(() => target.classList.remove("is-target"), 1600);
            }
            clearSettingsTarget();
        }, 80);
        return () => clearTimeout(timer);
    }, [settingsTarget, activeCategory, clearSettingsTarget]);

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
    // 开机自启：状态以注册表为准，初始化时从后端读取
    const [autoStart, setAutoStart] = useState(false);
    const [autoStartBusy, setAutoStartBusy] = useState(false);
    // 关闭到托盘：值保存在 settings.json，由后端在关闭窗口时读取
    const [closeToTray, setCloseToTray] = useState(false);
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
                setCloseToTray(s.close_to_tray);
            })
            .catch(() => {});
    }, [isWebDAVModalOpen, isServerModalOpen]);

    // 读取开机自启状态。非 Windows 平台后端返回错误，此处静默按未启用展示
    useEffect(() => {
        SettingsService.GetAutoStart()
            .then(setAutoStart)
            .catch(() => setAutoStart(false));
    }, []);

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
        const url = releaseInfo?.htmlUrl;
        if (!url) return;
        try {
            await UpdaterService.OpenReleasePage(url);
        } catch {
            // 后端拒绝打开时才退回浏览器。只允许 http(s)：window.open 接受
            // file:// 与自定义协议，受损的渲染进程可借此启动本地程序，
            // 因此不能把远端返回的链接原样交给它。
            if (/^https?:\/\//i.test(url)) {
                window.open(url, "_blank", "noopener,noreferrer");
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

    // 开机自启：写当前用户注册表 Run 项，无需管理员权限
    const handleAutoStartToggle = async (enabled: boolean) => {
        const prev = autoStart;
        setAutoStart(enabled);
        setAutoStartBusy(true);
        try {
            await SettingsService.SetAutoStart(enabled);
            toast.success(t(enabled ? "auto_start_enabled" : "auto_start_disabled"));
        } catch (error) {
            setAutoStart(prev);
            handleAppError(error);
        } finally {
            setAutoStartBusy(false);
        }
    };

    // 关闭到托盘：值写入 settings.json，后端在窗口关闭事件里读取后决定隐藏还是退出
    const handleCloseToTrayToggle = async (enabled: boolean) => {
        const prev = closeToTray;
        setCloseToTray(enabled);
        try {
            const current = await SettingsService.GetSettings();
            await SettingsService.SaveSettings(new AppSettings({
                ...current,
                close_to_tray: enabled,
            }));
            toast.success(t(enabled ? "close_to_tray_enabled" : "close_to_tray_disabled"));
        } catch (error) {
            setCloseToTray(prev);
            handleAppError(error);
        }
    };

    // 清空最近连接：记录只存在本地文件，清空不影响主机本身
    const handleClearRecentHosts = async () => {
        try {
            await SettingsService.ClearRecentHosts();
            toast.success(t("clear_recent_done"));
        } catch (error) {
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
        <div className="lazy-fade-in settings-page flex h-full w-full">

            {/* 左侧分类导航：设置页占用完整内容区，标题栏品牌区与这条导航同宽 */}
            <nav className="settings-rail">
                <div className="settings-rail-head">
                    <button
                        type="button"
                        onClick={exitSettings}
                        className="settings-back-btn"
                        title={t("back_workspace")}
                        aria-label={t("back_workspace")}
                    >
                        <ChevronLeft className="size-4"/>
                    </button>
                    <h1 className="settings-rail-title">{t("page_title")}</h1>
                </div>

                <div className="settings-rail-scroll">
                    <div className="settings-nav">
                        {NAV_GROUPS.map((group, groupIndex) => (
                            <div key={groupIndex} className="flex flex-col">
                                {group.labelKey && (
                                    <div className="settings-nav-label">{t(group.labelKey)}</div>
                                )}
                                {group.items.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        aria-current={activeCategory === item.id ? "page" : undefined}
                                        onClick={() => setActiveCategory(item.id)}
                                        className={cn("settings-nav-item", activeCategory === item.id && "is-active")}
                                    >
                                        <item.icon className="size-3.5 shrink-0"/>
                                        <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            </nav>

            {/* 右侧内容区 */}
            <div className="min-w-0 flex-1 overflow-y-auto">
                <div className="settings-content">

                    {/* ============ 外观 ============ */}
                    {activeCategory === "appearance" && (
                        <SettingsCard title={t("preferences_title")}>
                            <SettingsRow
                                id="setting-theme"
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

                            <SettingsRow id="setting-skin" title={t("skin_label")} desc={t("skin_desc")}>
                                <SettingsSegmented
                                    value={skin}
                                    onChange={handleSkinChange}
                                    options={SKIN_PRESETS.map((preset) => ({
                                        value: preset.value,
                                        label: t(preset.labelKey),
                                    }))}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-language" title={t("language_label")}>
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

                            <SettingsRow id="setting-accent" title={t("accent_color_label")} desc={t("accent_color_desc")}>
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

                            <SettingsRow id="setting-density" title={t("density_label")} desc={t("density_desc")}>
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
                        <SettingsCard title={t("terminal_appearance_title")} description={t("terminal_appearance_desc")}>
                            <SettingsRow
                                id="setting-terminal-scheme"
                                title={t("terminal_scheme_label")}
                                desc={t("terminal_scheme_desc")}
                            >
                                <div className="flex items-center gap-3">
                                    {/* 配色小样：底色 + 红/绿/黄/蓝，随选中方案实时变化 */}
                                    <div className="flex items-center gap-1" aria-hidden="true">
                                        {getTerminalSchemePreview(
                                            terminalColorScheme,
                                            effectiveDark ? "dark" : "light",
                                            accentColor,
                                            skin,
                                            customTerminalColors,
                                        ).map((color, index) => (
                                            <span
                                                key={index}
                                                className="size-3.5 rounded-sm ring-1 ring-[var(--hairline-strong)]"
                                                style={{backgroundColor: color}}
                                            />
                                        ))}
                                    </div>
                                    <Select
                                        value={terminalColorScheme}
                                        onValueChange={(v) => setTerminalColorScheme(v as TerminalColorScheme)}
                                    >
                                        <SelectTrigger className="settings-control w-44 text-[12.5px]">
                                            <SelectValue/>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {TERMINAL_COLOR_SCHEME_PRESETS.map((preset) => (
                                                <SelectItem key={preset.value} value={preset.value}>
                                                    {t(preset.labelKey)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </SettingsRow>

                            {/* 自定义配色：仅在选择"自定义"时展开色块编辑器 */}
                            {terminalColorScheme === "custom" && (
                                <SettingsRow
                                    title={t("terminal_custom_colors_label")}
                                    desc={t("terminal_custom_colors_desc")}
                                >
                                    <div className="flex flex-col items-end gap-2">
                                        <div className="flex max-w-[220px] flex-wrap justify-end gap-1.5">
                                            {CUSTOM_COLOR_ITEMS.map(({key, label}) => (
                                                <label
                                                    key={key}
                                                    title={label}
                                                    className="relative size-4 cursor-pointer rounded-[3px] ring-1
                                                               ring-[var(--hairline-strong)] transition-transform hover:scale-110"
                                                    style={{backgroundColor: customTerminalColors[key]}}
                                                >
                                                    <input
                                                        type="color"
                                                        value={customTerminalColors[key]}
                                                        onChange={(e) => setCustomTerminalColor(key, e.target.value)}
                                                        aria-label={label}
                                                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                                                    />
                                                </label>
                                            ))}
                                        </div>
                                        <Button
                                            size="xs"
                                            variant="ghost"
                                            onClick={resetCustomTerminalColors}
                                            className="h-6 px-2 text-[11px]"
                                        >
                                            <RotateCw className="size-3"/>
                                            {t("terminal_custom_colors_reset")}
                                        </Button>
                                    </div>
                                </SettingsRow>
                            )}

                            <SettingsRow id="setting-terminal-font-size" title={t("terminal_font_size_label")} desc={t("terminal_font_size_desc")}>
                                <SettingsStepper
                                    value={terminalFontSize}
                                    min={TERMINAL_FONT_SIZE_MIN}
                                    max={TERMINAL_FONT_SIZE_MAX}
                                    onChange={setTerminalFontSize}
                                    format={(v) => `${v}px`}
                                    label={t("terminal_font_size_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-terminal-font-family" title={t("terminal_font_family_label")} desc={t("terminal_font_family_desc")}>
                                <Input
                                    value={terminalFontFamily}
                                    onChange={(e) => setTerminalFontFamily(e.target.value)}
                                    placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
                                    spellCheck={false}
                                    aria-label={t("terminal_font_family_label")}
                                    className="h-8 w-64 max-w-full font-mono text-xs"
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-terminal-line-height" title={t("terminal_line_height_label")} desc={t("terminal_line_height_desc")}>
                                <SettingsStepper
                                    value={terminalLineHeight}
                                    min={TERMINAL_LINE_HEIGHT_MIN}
                                    max={TERMINAL_LINE_HEIGHT_MAX}
                                    step={0.1}
                                    onChange={setTerminalLineHeight}
                                    format={(v) => v.toFixed(1)}
                                    label={t("terminal_line_height_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("terminal_cursor_style_label")} desc={t("terminal_cursor_style_desc")}>
                                <div className="flex flex-wrap items-center gap-3">
                                    <SettingsSegmented
                                        value={terminalCursorStyle}
                                        onChange={setTerminalCursorStyle}
                                        options={[
                                            {value: "block", label: t("cursor_style_block")},
                                            {value: "bar", label: t("cursor_style_bar")},
                                            {value: "underline", label: t("cursor_style_underline")},
                                        ]}
                                    />
                                    <SettingsSwitch
                                        checked={terminalCursorBlink}
                                        onChange={setTerminalCursorBlink}
                                        label={t("terminal_cursor_blink_label")}
                                    />
                                    <span className="text-[11.5px] text-[var(--fg-muted)]">
                                        {t("terminal_cursor_blink_label")}
                                    </span>
                                </div>
                            </SettingsRow>

                            <SettingsRow id="setting-terminal-scrollback" title={t("terminal_scrollback_label")} desc={t("terminal_scrollback_desc")}>
                                <SettingsSegmented
                                    value={terminalScrollback}
                                    onChange={setTerminalScrollback}
                                    options={[
                                        {value: 1000, label: "1k"},
                                        {value: 5000, label: "5k"},
                                        {value: 10000, label: "10k"},
                                        {value: 30000, label: "30k"},
                                        {value: 50000, label: "50k"},
                                    ]}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("close_tab_confirm_label")} desc={t("close_tab_confirm_desc")}>
                                <SettingsSwitch
                                    checked={closeTabConfirm}
                                    onChange={setCloseTabConfirm}
                                    label={t("close_tab_confirm_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("copy_on_select_label")} desc={t("copy_on_select_desc")}>
                                <SettingsSwitch
                                    checked={copyOnSelect}
                                    onChange={setCopyOnSelect}
                                    label={t("copy_on_select_label")}
                                />
                            </SettingsRow>
                        </SettingsCard>

                        <SettingsCard title={t("terminal_features_title")} description={t("terminal_features_desc")}>
                            <SettingsRow id="setting-keyword-highlight" title={t("keyword_highlight_label")} desc={t("keyword_highlight_desc")}>
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

                            <SettingsRow id="setting-paste-protection" title={t("paste_protection_label")} desc={t("paste_protection_desc")}>
                                <SettingsSwitch
                                    checked={pasteProtection}
                                    onChange={setPasteProtection}
                                    label={t("paste_protection_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-auto-reconnect" title={t("auto_reconnect_label")} desc={t("auto_reconnect_desc")}>
                                <SettingsSwitch
                                    checked={autoReconnect}
                                    onChange={setAutoReconnect}
                                    label={t("auto_reconnect_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-sftp-follow-cwd" title={t("sftp_follow_cwd_label")} desc={t("sftp_follow_cwd_desc")}>
                                <SettingsSwitch
                                    checked={sftpFollowCwd}
                                    onChange={setSftpFollowCwd}
                                    label={t("sftp_follow_cwd_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-command-suggestions" title={t("command_suggestions_label")} desc={t("command_suggestions_desc")}>
                                <SettingsSwitch
                                    checked={commandSuggestions}
                                    onChange={setCommandSuggestions}
                                    label={t("command_suggestions_label")}
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

                        <SettingsCard title={t("monitor_alerts_title")} description={t("monitor_alerts_desc")}>
                            <SettingsRow id="setting-monitor-alerts" title={t("monitor_alerts_enabled_label")} desc={t("monitor_alerts_enabled_desc")}>
                                <SettingsSwitch
                                    checked={monitorAlertsEnabled}
                                    onChange={setMonitorAlertsEnabled}
                                    label={t("monitor_alerts_enabled_label")}
                                />
                            </SettingsRow>

                            <SettingsRow title={t("monitor_desktop_notify_label")} desc={t("monitor_desktop_notify_desc")}>
                                <SettingsSwitch
                                    checked={monitorDesktopNotify}
                                    onChange={setMonitorDesktopNotify}
                                    label={t("monitor_desktop_notify_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-monitor-cpu-threshold" title={t("monitor_cpu_threshold_label")} desc={t("monitor_threshold_desc")}>
                                <SettingsStepper
                                    value={monitorCpuThreshold}
                                    min={1}
                                    max={100}
                                    step={5}
                                    format={(value) => `${value}%`}
                                    onChange={setMonitorCpuThreshold}
                                    label={t("monitor_cpu_threshold_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-monitor-memory-threshold" title={t("monitor_memory_threshold_label")} desc={t("monitor_threshold_desc")}>
                                <SettingsStepper
                                    value={monitorMemoryThreshold}
                                    min={1}
                                    max={100}
                                    step={5}
                                    format={(value) => `${value}%`}
                                    onChange={setMonitorMemoryThreshold}
                                    label={t("monitor_memory_threshold_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-monitor-disk-threshold" title={t("monitor_disk_threshold_label")} desc={t("monitor_threshold_desc")}>
                                <SettingsStepper
                                    value={monitorDiskThreshold}
                                    min={1}
                                    max={100}
                                    step={5}
                                    format={(value) => `${value}%`}
                                    onChange={setMonitorDiskThreshold}
                                    label={t("monitor_disk_threshold_label")}
                                />
                            </SettingsRow>

                            <SettingsRow id="setting-monitor-alert-streak" title={t("monitor_alert_streak_label")} desc={t("monitor_alert_streak_desc")}>
                                <SettingsStepper
                                    value={monitorAlertStreak}
                                    min={1}
                                    max={10}
                                    step={1}
                                    onChange={setMonitorAlertStreak}
                                    label={t("monitor_alert_streak_label")}
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
                                            <div className="truncate text-[12.5px] text-[var(--fg-strong)]">
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
                                    <span className="truncate text-[14px] text-[var(--fg-strong)]">
                                        {user?.username || t("loading", {ns: "common"})}
                                    </span>
                                </div>
                            </div>

                            {lastError && (
                                <div className="callout is-danger mx-4 mb-3">
                                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
                                    <div className="flex min-w-0 flex-col gap-0.5">
                                        <span className="text-[12px]">{t("sync_offline")}</span>
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

                            <SettingsRow title={t("auto_lock_label")} desc={t("auto_lock_desc")}>
                                <SettingsSegmented
                                    value={autoLockMinutes}
                                    onChange={setAutoLockMinutes}
                                    options={[
                                        {value: 0, label: t("auto_lock_off")},
                                        {value: 1, label: "1m"},
                                        {value: 5, label: "5m"},
                                        {value: 15, label: "15m"},
                                        {value: 30, label: "30m"},
                                        {value: 60, label: "1h"},
                                    ]}
                                />
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

                    {/* ============ 系统 ============ */}
                    {activeCategory === "system" && (
                        <SettingsCard title={t("system_title")} description={t("system_desc")}>
                            <SettingsRow title={t("auto_start_label")} desc={t("auto_start_desc")}>
                                <div className="flex items-center gap-2">
                                    {autoStartBusy && (
                                        <Loader2 className="size-3.5 animate-spin text-[var(--fg-muted)]"/>
                                    )}
                                    <SettingsSwitch
                                        checked={autoStart}
                                        onChange={handleAutoStartToggle}
                                        disabled={autoStartBusy}
                                        label={t("auto_start_label")}
                                    />
                                </div>
                            </SettingsRow>
                            <SettingsRow title={t("close_to_tray_label")} desc={t("close_to_tray_desc")}>
                                <SettingsSwitch
                                    checked={closeToTray}
                                    onChange={handleCloseToTrayToggle}
                                    label={t("close_to_tray_label")}
                                />
                            </SettingsRow>
                            <SettingsRow title={t("clear_recent_label")} desc={t("clear_recent_desc")}>
                                <Button
                                    variant="outline"
                                    className="settings-control"
                                    onClick={handleClearRecentHosts}
                                >
                                    <Trash2 className="mr-1.5 size-3.5"/>
                                    {t("clear_recent_btn")}
                                </Button>
                            </SettingsRow>
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
                                            <div className="mb-2 flex items-start gap-2">
                                                <Download className="mt-0.5 size-4 shrink-0 text-primary"/>
                                                <span className="min-w-0 break-words text-[13px] text-primary">
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
                                                        <span className="text-[11.5px] text-[var(--fg-strong)]">
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
                                        <div className="flex items-start gap-2">
                                            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]"/>
                                            <span className="min-w-0 break-words text-[13px] text-[var(--fg-strong)]">
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