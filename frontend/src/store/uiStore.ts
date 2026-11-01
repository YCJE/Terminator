import { create } from "zustand";
import { loadHighlightRules, saveHighlightRules } from "@/lib/highlightRules";
import type { HighlightRule } from "@/lib/highlightRules";
import { isTerminalColorScheme, isHexColor, DEFAULT_CUSTOM_TERMINAL_COLORS, type TerminalColorScheme, type CustomTerminalColors, type CustomTerminalColorKey } from "@/lib/terminalTheme";
import {
    DEFAULT_SHORTCUTS,
    loadShortcuts,
    saveShortcuts,
    type ShortcutCombo,
    type ShortcutId,
    type ShortcutMap,
} from "@/lib/shortcuts";

export enum ViewType {
    Hosts = "hosts",
    Keys = "keys",
    PortForwarding = "port-forwarding",
    BatchExec = "batch-exec",
    Settings = "settings",
    Terminal = "terminal",
}

/** 设置页的分类标识，提到全局以便从其他页面跳转定位 */
export type SettingsCategory = "appearance" | "terminal" | "shortcuts" | "sync" | "security" | "system" | "about";

export type Theme = "dark" | "light";
export type AccentColor = "monochrome" | "sky" | "emerald" | "violet" | "amber" | "rose" | "cyan";
export type Spaciness = 0.8 | 1 | 1.2;
/** 皮肤：default = 现有外观；hud = HUD 战术（暗）；editorial = 编辑纸感（亮） */
export type Skin = "default" | "hud" | "editorial";
/** 终端光标样式（与 xterm 的 cursorStyle 取值一致） */
export type TerminalCursorStyle = "block" | "bar" | "underline";

/** 终端外观取值范围，设置页控件与 Ctrl+滚轮缩放共用同一组边界 */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_LINE_HEIGHT_MIN = 1;
export const TERMINAL_LINE_HEIGHT_MAX = 2;
export const TERMINAL_SCROLLBACK_MIN = 1000;
export const TERMINAL_SCROLLBACK_MAX = 50000;

interface UIState {
    activeView: ViewType;
    /** 进入设置前的视图：设置页隐藏主侧栏，返回时回到用户原来的页面 */
    returnView: ViewType;
    /** 设置页当前分类（全局保存，便于从冲突提示等处直接跳转到对应分类） */
    settingsCategory: SettingsCategory;
    /** 设置页内要定位并高亮的具体设置项 id（命令面板搜索直达） */
    settingsTarget: string | null;
    isSidebarVisible: boolean;
    isFilePanelVisible: boolean;
    /** 服务器监控侧栏：与文件面板共用同一条侧栏位置，二者互斥 */
    isMonitorPanelVisible: boolean;
    isSnippetPanelVisible: boolean;
    /** 命令面板（Ctrl+Shift+P）是否打开 */
    isCommandPaletteOpen: boolean;
    updateVersionReady: string | null;
    dismissedUpdateVersion: string | null;
    /**
     * 仅通知、需用户手动下载的更新（来自 GitHub Release 检查）。
     * 发布构建禁用 cgo，velopack 不可用，此时靠该字段提示新版本。
     */
    updateReleaseUrl: string | null;
    updateReleaseVersion: string | null;
    /** 本次运行内暂时忽略更新提示（点"稍后提醒"，不写盘，重启后会再次提示） */
    updateSnoozedForSession: boolean;
    snoozeUpdateForSession: (snoozed: boolean) => void;
    /** 快速连接对话框（无需保存主机，直接输入地址与凭据连接） */
    isQuickConnectOpen: boolean;
    setQuickConnectOpen: (open: boolean) => void;
    theme: Theme;
    accentColor: AccentColor;
    spaciness: Spaciness;
    skin: Skin;
    terminalColorLink: boolean;
    /** 终端配色方案：default 跟随主题/强调色，其余为固定经典配色 */
    terminalColorScheme: TerminalColorScheme;
    /** 自定义 ANSI 配色（terminalColorScheme === "custom" 时生效） */
    customTerminalColors: CustomTerminalColors;
    /** 终端关键词高亮开关（前端纯本地设置，持久化到 localStorage） */
    keywordHighlight: boolean;
    setActiveView: (view: ViewType) => void;
    setSettingsCategory: (category: SettingsCategory) => void;
    /** 切换到设置页并定位到指定分类 */
    openSettingsSection: (category: SettingsCategory) => void;
    /** 切换到设置页、定位分类并滚动到具体设置项 */
    openSettingsTarget: (category: SettingsCategory, target: string) => void;
    /** 定位完成后清除目标，避免下次进入设置页重复滚动 */
    clearSettingsTarget: () => void;
    /** 离开设置页，回到进入前的视图 */
    exitSettings: () => void;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    setFilePanelVisible: (visible: boolean) => void;
    toggleMonitorPanel: () => void;
    setMonitorPanelVisible: (visible: boolean) => void;
    toggleSnippetPanel: () => void;
    setSnippetPanelVisible: (visible: boolean) => void;
    setCommandPaletteOpen: (open: boolean) => void;
    setUpdateVersionReady: (version: string | null) => void;
    setDismissedUpdateVersion: (version: string | null) => void;
    setUpdateRelease: (version: string | null, url: string | null) => void;
    setTheme: (theme: Theme) => void;
    setAccentColor: (color: AccentColor) => void;
    setSpaciness: (s: Spaciness) => void;
    setSkin: (skin: Skin) => void;
    setTerminalColorLink: (enabled: boolean) => void;
    setTerminalColorScheme: (scheme: TerminalColorScheme) => void;
    setCustomTerminalColor: (key: CustomTerminalColorKey, value: string) => void;
    resetCustomTerminalColors: () => void;
    setKeywordHighlight: (enabled: boolean) => void;
    /** 广播模式功能开关（控制广播按钮是否显示） */
    broadcastEnabled: boolean;
    toggleBroadcastEnabled: () => void;
    /** 标签页自定义颜色功能开关（控制右键颜色选择是否可用） */
    tabColorEnabled: boolean;
    toggleTabColorEnabled: () => void;
    /** 多行粘贴二次确认（防止误将多行命令灌入生产终端） */
    pasteProtection: boolean;
    setPasteProtection: (enabled: boolean) => void;
    /** 断线后自动重连（最多 3 次，指数退避） */
    autoReconnect: boolean;
    setAutoReconnect: (enabled: boolean) => void;
    /** SFTP 面板跟随终端当前目录（依赖 shell 上报 OSC 7） */
    sftpFollowCwd: boolean;
    setSftpFollowCwd: (enabled: boolean) => void;
    /** 终端命令行补全提示（基于历史命令与常用命令，Tab 接受） */
    commandSuggestions: boolean;
    setCommandSuggestions: (enabled: boolean) => void;
    /** 服务器监控告警：CPU/内存/磁盘使用率连续超过阈值时提示 */
    monitorAlertsEnabled: boolean;
    setMonitorAlertsEnabled: (enabled: boolean) => void;
    /** 告警触发时是否同时发送系统桌面通知（仅窗口隐藏时） */
    monitorDesktopNotify: boolean;
    setMonitorDesktopNotify: (enabled: boolean) => void;
    monitorCpuThreshold: number;
    monitorMemoryThreshold: number;
    monitorDiskThreshold: number;
    setMonitorCpuThreshold: (value: number) => void;
    setMonitorMemoryThreshold: (value: number) => void;
    setMonitorDiskThreshold: (value: number) => void;
    /** 连续多少个采样点超阈值才触发告警（1-10） */
    monitorAlertStreak: number;
    setMonitorAlertStreak: (value: number) => void;
    /** 命令草稿栏（多行编辑后统一发送） */
    isComposePanelVisible: boolean;
    toggleComposePanel: () => void;
    setComposePanelVisible: (visible: boolean) => void;
    /** 启动时恢复上次工作区（标签顺序与分屏布局） */
    workspaceRestore: boolean;
    setWorkspaceRestore: (enabled: boolean) => void;
    /**
     * SFTP 面板导航请求（命令面板搜索远端文件后跳转）。
     * nonce 每次递增：面板只在 nonce 变化时导航，避免重复触发。
     */
    sftpNavigateRequest: { sessionId: string; path: string; nonce: number } | null;
    requestSftpNavigate: (sessionId: string, path: string) => void;
    /** 终端自定义高亮规则 */
    highlightRules: HighlightRule[];
    addHighlightRule: (rule: Omit<HighlightRule, "id">) => void;
    updateHighlightRule: (id: string, updates: Partial<Omit<HighlightRule, "id">>) => void;
    removeHighlightRule: (id: string) => void;
    /** 命令完成 / 终端通知（OSC 133;D、OSC 9、OSC 777） */
    completionNotify: boolean;
    setCompletionNotify: (enabled: boolean) => void;
    /**
     * 终端外观：字号 / 字体 / 光标 / 行高 / 滚动缓冲。
     * TerminalInstance 订阅这些字段后直接改 term.options 并 fit，
     * 无需重建终端，因此调整时不会丢失当前输出。
     */
    terminalFontSize: number;
    /** 空字符串表示使用内置字体栈 */
    terminalFontFamily: string;
    terminalCursorStyle: TerminalCursorStyle;
    terminalCursorBlink: boolean;
    terminalLineHeight: number;
    terminalScrollback: number;
    setTerminalFontSize: (size: number) => void;
    setTerminalFontFamily: (family: string) => void;
    setTerminalCursorStyle: (style: TerminalCursorStyle) => void;
    setTerminalCursorBlink: (enabled: boolean) => void;
    setTerminalLineHeight: (lineHeight: number) => void;
    setTerminalScrollback: (lines: number) => void;
    /** 关闭标签页前二次确认（Termius / Windows Terminal 的默认行为） */
    closeTabConfirm: boolean;
    setCloseTabConfirm: (enabled: boolean) => void;
    /** 选中即复制：终端里拖选文本后自动写入剪贴板 */
    copyOnSelect: boolean;
    setCopyOnSelect: (enabled: boolean) => void;
    /** 空闲自动锁屏分钟数，0 表示关闭 */
    autoLockMinutes: number;
    setAutoLockMinutes: (minutes: number) => void;
    /** 可配置快捷键（已合并本地覆盖） */
    shortcuts: ShortcutMap;
    setShortcut: (id: ShortcutId, combo: ShortcutCombo) => void;
    resetShortcut: (id: ShortcutId) => void;
    resetAllShortcuts: () => void;
}

// ---- 前端本地设置的 localStorage 持久化 ----
// 这些功能为纯前端特性（不涉及后端），使用 localStorage 独立持久化

/** 从 localStorage 读取布尔值，未存储时返回默认值 */
function loadBool(key: string, defaultValue: boolean): boolean {
    try {
        const stored = localStorage.getItem(key);
        if (stored === null) return defaultValue;
        return stored === 'true';
    } catch {
        return defaultValue;
    }
}

/** 将布尔值持久化到 localStorage */
function saveBool(key: string, value: boolean): void {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // localStorage 不可用时静默忽略
    }
}

/** 从 localStorage 读取数值并夹到 [min, max]，缺失或非法时回退默认值 */
function loadNumber(key: string, defaultValue: number, min: number, max: number): number {
    try {
        const stored = localStorage.getItem(key);
        if (stored === null) return defaultValue;
        const parsed = Number(stored);
        if (!Number.isFinite(parsed)) return defaultValue;
        return Math.min(max, Math.max(min, parsed));
    } catch {
        return defaultValue;
    }
}

/** 将数值持久化到 localStorage */
function saveNumber(key: string, value: number): void {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // localStorage 不可用时静默忽略
    }
}

/** 从 localStorage 读取字符串，缺失时返回默认值 */
function loadString(key: string, defaultValue: string): string {
    try {
        return localStorage.getItem(key) ?? defaultValue;
    } catch {
        return defaultValue;
    }
}

/** 将字符串持久化到 localStorage */
function saveString(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // localStorage 不可用时静默忽略
    }
}

const STORAGE_KEYS = {
    keywordHighlight: 'terminator_keyword_highlight',
    broadcastEnabled: 'terminator_broadcast_enabled',
    tabColorEnabled: 'terminator_tab_color_enabled',
    pasteProtection: 'terminator_paste_protection',
    autoReconnect: 'terminator_auto_reconnect',
    sftpFollowCwd: 'terminator_sftp_follow_cwd',
    commandSuggestions: 'terminator_command_suggestions',
    monitorAlertsEnabled: 'terminator_monitor_alerts_enabled',
    monitorDesktopNotify: 'terminator_monitor_desktop_notify',
    monitorCpuThreshold: 'terminator_monitor_cpu_threshold',
    monitorMemoryThreshold: 'terminator_monitor_memory_threshold',
    monitorDiskThreshold: 'terminator_monitor_disk_threshold',
    monitorAlertStreak: 'terminator_monitor_alert_streak',
    workspaceRestore: 'terminator_workspace_restore',
    completionNotify: 'terminator_completion_notify',
    terminalFontSize: 'terminator_terminal_font_size',
    terminalFontFamily: 'terminator_terminal_font_family',
    terminalCursorStyle: 'terminator_terminal_cursor_style',
    terminalCursorBlink: 'terminator_terminal_cursor_blink',
    terminalLineHeight: 'terminator_terminal_line_height',
    terminalScrollback: 'terminator_terminal_scrollback',
    terminalColorScheme: 'terminator_terminal_color_scheme',
    customTerminalColors: 'terminator_terminal_custom_colors',
    closeTabConfirm: 'terminator_close_tab_confirm',
    copyOnSelect: 'terminator_copy_on_select',
    autoLockMinutes: 'terminator_auto_lock_minutes',
    dismissedUpdateVersion: 'terminator_dismissed_update_version',
} as const;

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    returnView: ViewType.Hosts,
    settingsCategory: "appearance",
    settingsTarget: null,
    isSidebarVisible: true,
    isFilePanelVisible: false,
    isMonitorPanelVisible: false,
    isSnippetPanelVisible: false,
    isComposePanelVisible: false,
    isCommandPaletteOpen: false,
    updateVersionReady: null,
    // 跳过的版本写入 localStorage：重启后不再提示同一个版本
    dismissedUpdateVersion: loadString(STORAGE_KEYS.dismissedUpdateVersion, "") || null,
    updateReleaseUrl: null,
    updateReleaseVersion: null,
    updateSnoozedForSession: false,
    isQuickConnectOpen: false,
    theme: "dark",
    accentColor: "sky",
    spaciness: 1,
    skin: "default",
    terminalColorLink: false,
    terminalColorScheme: (() => {
        const raw = loadString(STORAGE_KEYS.terminalColorScheme, "default");
        return isTerminalColorScheme(raw) ? raw : "default";
    })(),
    customTerminalColors: (() => {
        const raw = loadString(STORAGE_KEYS.customTerminalColors, "");
        if (!raw) return DEFAULT_CUSTOM_TERMINAL_COLORS;
        try {
            const parsed = JSON.parse(raw) as Partial<CustomTerminalColors>;
            const merged: CustomTerminalColors = {...DEFAULT_CUSTOM_TERMINAL_COLORS};
            for (const key of Object.keys(merged) as CustomTerminalColorKey[]) {
                const value = parsed[key];
                // 只接受合法的 #RRGGBB，坏数据回退默认色而不是让终端渲染异常
                if (typeof value === "string" && isHexColor(value)) merged[key] = value;
            }
            return merged;
        } catch {
            return DEFAULT_CUSTOM_TERMINAL_COLORS;
        }
    })(),
    keywordHighlight: loadBool(STORAGE_KEYS.keywordHighlight, true),
    broadcastEnabled: loadBool(STORAGE_KEYS.broadcastEnabled, false),
    tabColorEnabled: loadBool(STORAGE_KEYS.tabColorEnabled, false),
    pasteProtection: loadBool(STORAGE_KEYS.pasteProtection, true),
    autoReconnect: loadBool(STORAGE_KEYS.autoReconnect, false),
    sftpFollowCwd: loadBool(STORAGE_KEYS.sftpFollowCwd, true),
    commandSuggestions: loadBool(STORAGE_KEYS.commandSuggestions, true),
    monitorAlertsEnabled: loadBool(STORAGE_KEYS.monitorAlertsEnabled, true),
    monitorDesktopNotify: loadBool(STORAGE_KEYS.monitorDesktopNotify, true),
    monitorCpuThreshold: loadNumber(STORAGE_KEYS.monitorCpuThreshold, 90, 1, 100),
    monitorMemoryThreshold: loadNumber(STORAGE_KEYS.monitorMemoryThreshold, 90, 1, 100),
    monitorDiskThreshold: loadNumber(STORAGE_KEYS.monitorDiskThreshold, 90, 1, 100),
    monitorAlertStreak: loadNumber(STORAGE_KEYS.monitorAlertStreak, 3, 1, 10),
    workspaceRestore: loadBool(STORAGE_KEYS.workspaceRestore, true),
    completionNotify: loadBool(STORAGE_KEYS.completionNotify, true),
    terminalFontSize: loadNumber(
        STORAGE_KEYS.terminalFontSize,
        14,
        TERMINAL_FONT_SIZE_MIN,
        TERMINAL_FONT_SIZE_MAX,
    ),
    terminalFontFamily: loadString(STORAGE_KEYS.terminalFontFamily, ""),
    terminalCursorStyle: (() => {
        const raw = loadString(STORAGE_KEYS.terminalCursorStyle, "bar");
        return raw === "block" || raw === "underline" ? raw : "bar";
    })(),
    terminalCursorBlink: loadBool(STORAGE_KEYS.terminalCursorBlink, true),
    terminalLineHeight: loadNumber(
        STORAGE_KEYS.terminalLineHeight,
        1.3,
        TERMINAL_LINE_HEIGHT_MIN,
        TERMINAL_LINE_HEIGHT_MAX,
    ),
    terminalScrollback: loadNumber(
        STORAGE_KEYS.terminalScrollback,
        10000,
        TERMINAL_SCROLLBACK_MIN,
        TERMINAL_SCROLLBACK_MAX,
    ),
    closeTabConfirm: loadBool(STORAGE_KEYS.closeTabConfirm, false),
    copyOnSelect: loadBool(STORAGE_KEYS.copyOnSelect, false),
    autoLockMinutes: loadNumber(STORAGE_KEYS.autoLockMinutes, 0, 0, 240),
    sftpNavigateRequest: null,
    requestSftpNavigate: (sessionId, path) => set((state) => ({
        sftpNavigateRequest: {
            sessionId,
            path,
            nonce: (state.sftpNavigateRequest?.nonce ?? 0) + 1,
        },
    })),
    highlightRules: loadHighlightRules(),
    shortcuts: loadShortcuts(),
    // 记录最近一次非设置视图：设置页占用整块内容区（主侧栏隐藏），
    // 返回按钮据此回到用户进入设置前的页面，而不是固定跳回终端。
    setActiveView: (view) => set((state) => view === ViewType.Settings
        ? {activeView: view}
        : {activeView: view, returnView: view}),
    setSettingsCategory: (category) => set({settingsCategory: category, settingsTarget: null}),
    openSettingsSection: (category) => set({
        activeView: ViewType.Settings,
        settingsCategory: category,
        settingsTarget: null,
    }),
    openSettingsTarget: (category, target) => set({
        activeView: ViewType.Settings,
        settingsCategory: category,
        settingsTarget: target,
    }),
    clearSettingsTarget: () => set({settingsTarget: null}),
    exitSettings: () => set((state) => ({
        activeView: state.returnView === ViewType.Settings ? ViewType.Hosts : state.returnView,
    })),
    toggleSidebar: () => set((state) => ({isSidebarVisible: !state.isSidebarVisible})),
    toggleFilePanel: () => set((state) => {
        const visible = !state.isFilePanelVisible;
        // 两条侧栏占用同一个位置：打开其中一个时关闭另一个
        return {isFilePanelVisible: visible, isMonitorPanelVisible: visible ? false : state.isMonitorPanelVisible};
    }),
    setFilePanelVisible: (visible) => set((state) => ({
        isFilePanelVisible: visible,
        isMonitorPanelVisible: visible ? false : state.isMonitorPanelVisible,
    })),
    toggleMonitorPanel: () => set((state) => {
        const visible = !state.isMonitorPanelVisible;
        return {isMonitorPanelVisible: visible, isFilePanelVisible: visible ? false : state.isFilePanelVisible};
    }),
    setMonitorPanelVisible: (visible) => set((state) => ({
        isMonitorPanelVisible: visible,
        isFilePanelVisible: visible ? false : state.isFilePanelVisible,
    })),
    toggleSnippetPanel: () => set((state) => ({isSnippetPanelVisible: !state.isSnippetPanelVisible})),
    setSnippetPanelVisible: (visible) => set({isSnippetPanelVisible: visible}),
    setCommandPaletteOpen: (open) => set({isCommandPaletteOpen: open}),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
    setDismissedUpdateVersion: (version) => {
        saveString(STORAGE_KEYS.dismissedUpdateVersion, version ?? "");
        set({ dismissedUpdateVersion: version });
    },
    setUpdateRelease: (version, url) => set({
        updateReleaseVersion: version,
        updateReleaseUrl: url,
        // 出现新的更新提示时重置"稍后提醒"，否则同一会话里永远不再显示
        updateSnoozedForSession: false,
    }),
    snoozeUpdateForSession: (snoozed) => set({ updateSnoozedForSession: snoozed }),
    setQuickConnectOpen: (open) => set({ isQuickConnectOpen: open }),
    setTheme: (theme) => set({ theme }),
    setAccentColor: (color) => set({ accentColor: color }),
    setSpaciness: (s) => set({ spaciness: s }),
    setSkin: (skin) => set({ skin }),
    setTerminalColorLink: (enabled) => set({ terminalColorLink: enabled }),
    setTerminalColorScheme: (scheme) => {
        saveString(STORAGE_KEYS.terminalColorScheme, scheme);
        set({ terminalColorScheme: scheme });
    },
    setCustomTerminalColor: (key, value) => {
        if (!isHexColor(value)) return;
        set((state) => {
            const next = {...state.customTerminalColors, [key]: value};
            saveString(STORAGE_KEYS.customTerminalColors, JSON.stringify(next));
            return {customTerminalColors: next};
        });
    },
    resetCustomTerminalColors: () => {
        saveString(STORAGE_KEYS.customTerminalColors, JSON.stringify(DEFAULT_CUSTOM_TERMINAL_COLORS));
        set({customTerminalColors: DEFAULT_CUSTOM_TERMINAL_COLORS});
    },
    setKeywordHighlight: (enabled) => {
        saveBool(STORAGE_KEYS.keywordHighlight, enabled);
        set({ keywordHighlight: enabled });
    },
    toggleBroadcastEnabled: () => set((state) => {
        const newVal = !state.broadcastEnabled;
        saveBool(STORAGE_KEYS.broadcastEnabled, newVal);
        // 关闭功能时同时关闭广播模式（延迟导入避免循环依赖）
        if (!newVal) {
            import("@/store/sessionStore").then(({useSessionStore}) => {
                useSessionStore.getState().setBroadcastMode(false);
            });
        }
        return { broadcastEnabled: newVal };
    }),
    toggleTabColorEnabled: () => set((state) => {
        const newVal = !state.tabColorEnabled;
        saveBool(STORAGE_KEYS.tabColorEnabled, newVal);
        return { tabColorEnabled: newVal };
    }),
    setPasteProtection: (enabled) => {
        saveBool(STORAGE_KEYS.pasteProtection, enabled);
        set({ pasteProtection: enabled });
    },
    setAutoReconnect: (enabled) => {
        saveBool(STORAGE_KEYS.autoReconnect, enabled);
        set({ autoReconnect: enabled });
    },
    setSftpFollowCwd: (enabled) => {
        saveBool(STORAGE_KEYS.sftpFollowCwd, enabled);
        set({ sftpFollowCwd: enabled });
    },
    setCommandSuggestions: (enabled) => {
        saveBool(STORAGE_KEYS.commandSuggestions, enabled);
        set({ commandSuggestions: enabled });
    },
    setMonitorAlertsEnabled: (enabled) => {
        saveBool(STORAGE_KEYS.monitorAlertsEnabled, enabled);
        set({ monitorAlertsEnabled: enabled });
    },
    setMonitorDesktopNotify: (enabled) => {
        saveBool(STORAGE_KEYS.monitorDesktopNotify, enabled);
        set({ monitorDesktopNotify: enabled });
    },
    setMonitorCpuThreshold: (value) => {
        // 阈值上下限与监控面板的百分比展示一致
        const clamped = Math.min(100, Math.max(1, Math.round(value)));
        saveNumber(STORAGE_KEYS.monitorCpuThreshold, clamped);
        set({ monitorCpuThreshold: clamped });
    },
    setMonitorMemoryThreshold: (value) => {
        const clamped = Math.min(100, Math.max(1, Math.round(value)));
        saveNumber(STORAGE_KEYS.monitorMemoryThreshold, clamped);
        set({ monitorMemoryThreshold: clamped });
    },
    setMonitorDiskThreshold: (value) => {
        const clamped = Math.min(100, Math.max(1, Math.round(value)));
        saveNumber(STORAGE_KEYS.monitorDiskThreshold, clamped);
        set({ monitorDiskThreshold: clamped });
    },
    setMonitorAlertStreak: (value) => {
        const clamped = Math.min(10, Math.max(1, Math.round(value)));
        saveNumber(STORAGE_KEYS.monitorAlertStreak, clamped);
        set({ monitorAlertStreak: clamped });
    },
    toggleComposePanel: () => set((state) => ({isComposePanelVisible: !state.isComposePanelVisible})),
    setComposePanelVisible: (visible) => set({isComposePanelVisible: visible}),
    setWorkspaceRestore: (enabled) => {
        saveBool(STORAGE_KEYS.workspaceRestore, enabled);
        set({ workspaceRestore: enabled });
    },
    addHighlightRule: (rule) => set((state) => {
        const next = [...state.highlightRules, {...rule, id: crypto.randomUUID()}];
        saveHighlightRules(next);
        return { highlightRules: next };
    }),
    updateHighlightRule: (id, updates) => set((state) => {
        const next = state.highlightRules.map((r) => (r.id === id ? {...r, ...updates} : r));
        saveHighlightRules(next);
        return { highlightRules: next };
    }),
    removeHighlightRule: (id) => set((state) => {
        const next = state.highlightRules.filter((r) => r.id !== id);
        saveHighlightRules(next);
        return { highlightRules: next };
    }),
    setCompletionNotify: (enabled) => {
        saveBool(STORAGE_KEYS.completionNotify, enabled);
        set({ completionNotify: enabled });
    },
    setTerminalFontSize: (size) => {
        const clamped = Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));
        saveNumber(STORAGE_KEYS.terminalFontSize, clamped);
        set({ terminalFontSize: clamped });
    },
    setTerminalFontFamily: (family) => {
        saveString(STORAGE_KEYS.terminalFontFamily, family);
        set({ terminalFontFamily: family });
    },
    setTerminalCursorStyle: (style) => {
        saveString(STORAGE_KEYS.terminalCursorStyle, style);
        set({ terminalCursorStyle: style });
    },
    setTerminalCursorBlink: (enabled) => {
        saveBool(STORAGE_KEYS.terminalCursorBlink, enabled);
        set({ terminalCursorBlink: enabled });
    },
    setTerminalLineHeight: (lineHeight) => {
        const clamped = Math.min(
            TERMINAL_LINE_HEIGHT_MAX,
            Math.max(TERMINAL_LINE_HEIGHT_MIN, lineHeight),
        );
        saveNumber(STORAGE_KEYS.terminalLineHeight, clamped);
        set({ terminalLineHeight: clamped });
    },
    setTerminalScrollback: (lines) => {
        const clamped = Math.min(
            TERMINAL_SCROLLBACK_MAX,
            Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(lines)),
        );
        saveNumber(STORAGE_KEYS.terminalScrollback, clamped);
        set({ terminalScrollback: clamped });
    },
    setCloseTabConfirm: (enabled) => {
        saveBool(STORAGE_KEYS.closeTabConfirm, enabled);
        set({ closeTabConfirm: enabled });
    },
    setCopyOnSelect: (enabled) => {
        saveBool(STORAGE_KEYS.copyOnSelect, enabled);
        set({ copyOnSelect: enabled });
    },
    setAutoLockMinutes: (minutes) => {
        const clamped = Math.min(240, Math.max(0, Math.round(minutes)));
        saveNumber(STORAGE_KEYS.autoLockMinutes, clamped);
        set({ autoLockMinutes: clamped });
    },
    setShortcut: (id, combo) => set((state) => {
        const next = {...state.shortcuts, [id]: combo};
        saveShortcuts(next);
        return { shortcuts: next };
    }),
    resetShortcut: (id) => set((state) => {
        const next = {...state.shortcuts, [id]: {...DEFAULT_SHORTCUTS[id]}};
        saveShortcuts(next);
        return { shortcuts: next };
    }),
    resetAllShortcuts: () => {
        const next: ShortcutMap = {...DEFAULT_SHORTCUTS};
        saveShortcuts(next);
        set({ shortcuts: next });
    },
}));

/** 强调色预设列表，供设置页面渲染选择器。labelKey 指向 settings 命名空间的文案键 */
export const ACCENT_PRESETS: { value: AccentColor; labelKey: string; color: string; colorDark?: string }[] = [
    { value: "monochrome", labelKey: "accent_monochrome", color: "#171717", colorDark: "#fafafa" },
    { value: "sky", labelKey: "accent_sky", color: "#0a84ff" },
    { value: "emerald", labelKey: "accent_emerald", color: "#34d399" },
    { value: "violet", labelKey: "accent_violet", color: "#a78bfa" },
    { value: "amber", labelKey: "accent_amber", color: "#fbbf24" },
    { value: "rose", labelKey: "accent_rose", color: "#fb7185" },
    { value: "cyan", labelKey: "accent_cyan", color: "#22d3ee" },
];

/** Spaciness 预设列表。labelKey 指向 settings 命名空间的文案键 */
export const SPACINESS_PRESETS: { value: Spaciness; labelKey: string }[] = [
    { value: 0.8, labelKey: "density_compact" },
    { value: 1, labelKey: "density_standard" },
    { value: 1.2, labelKey: "density_loose" },
];

/** 皮肤预设列表。labelKey 指向 settings 命名空间的文案键 */
export const SKIN_PRESETS: { value: Skin; labelKey: string }[] = [
    { value: "default", labelKey: "skin_default" },
    { value: "hud", labelKey: "skin_hud" },
    { value: "editorial", labelKey: "skin_editorial" },
];
