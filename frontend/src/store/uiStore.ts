import { create } from "zustand";
import { loadHighlightRules, saveHighlightRules } from "@/lib/highlightRules";
import type { HighlightRule } from "@/lib/highlightRules";
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
    Settings = "settings",
    Terminal = "terminal",
}

/** 设置页的分类标识，提到全局以便从其他页面跳转定位 */
export type SettingsCategory = "appearance" | "terminal" | "shortcuts" | "sync" | "security" | "about";

export type Theme = "dark" | "light";
export type AccentColor = "monochrome" | "sky" | "emerald" | "violet" | "amber" | "rose" | "cyan";
export type Spaciness = 0.8 | 1 | 1.2;
/** 皮肤：default = 现有外观；hud = HUD 战术（暗）；editorial = 编辑纸感（亮） */
export type Skin = "default" | "hud" | "editorial";

interface UIState {
    activeView: ViewType;
    /** 设置页当前分类（全局保存，便于从冲突提示等处直接跳转到对应分类） */
    settingsCategory: SettingsCategory;
    isSidebarVisible: boolean;
    isFilePanelVisible: boolean;
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
    theme: Theme;
    accentColor: AccentColor;
    spaciness: Spaciness;
    skin: Skin;
    terminalColorLink: boolean;
    /** 终端关键词高亮开关（前端纯本地设置，持久化到 localStorage） */
    keywordHighlight: boolean;
    setActiveView: (view: ViewType) => void;
    setSettingsCategory: (category: SettingsCategory) => void;
    /** 切换到设置页并定位到指定分类 */
    openSettingsSection: (category: SettingsCategory) => void;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    setFilePanelVisible: (visible: boolean) => void;
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
    /** 命令草稿栏（多行编辑后统一发送） */
    isComposePanelVisible: boolean;
    toggleComposePanel: () => void;
    setComposePanelVisible: (visible: boolean) => void;
    /** 启动时恢复上次工作区（标签顺序与分屏布局） */
    workspaceRestore: boolean;
    setWorkspaceRestore: (enabled: boolean) => void;
    /** 终端自定义高亮规则 */
    highlightRules: HighlightRule[];
    addHighlightRule: (rule: Omit<HighlightRule, "id">) => void;
    updateHighlightRule: (id: string, updates: Partial<Omit<HighlightRule, "id">>) => void;
    removeHighlightRule: (id: string) => void;
    /** 命令完成 / 终端通知（OSC 133;D、OSC 9、OSC 777） */
    completionNotify: boolean;
    setCompletionNotify: (enabled: boolean) => void;
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

const STORAGE_KEYS = {
    keywordHighlight: 'terminator_keyword_highlight',
    broadcastEnabled: 'terminator_broadcast_enabled',
    tabColorEnabled: 'terminator_tab_color_enabled',
    pasteProtection: 'terminator_paste_protection',
    autoReconnect: 'terminator_auto_reconnect',
    sftpFollowCwd: 'terminator_sftp_follow_cwd',
    workspaceRestore: 'terminator_workspace_restore',
    completionNotify: 'terminator_completion_notify',
} as const;

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    settingsCategory: "appearance",
    isSidebarVisible: true,
    isFilePanelVisible: false,
    isSnippetPanelVisible: false,
    isComposePanelVisible: false,
    isCommandPaletteOpen: false,
    updateVersionReady: null,
    dismissedUpdateVersion: null,
    updateReleaseUrl: null,
    updateReleaseVersion: null,
    theme: "dark",
    accentColor: "monochrome",
    spaciness: 1,
    skin: "default",
    terminalColorLink: false,
    keywordHighlight: loadBool(STORAGE_KEYS.keywordHighlight, true),
    broadcastEnabled: loadBool(STORAGE_KEYS.broadcastEnabled, false),
    tabColorEnabled: loadBool(STORAGE_KEYS.tabColorEnabled, false),
    pasteProtection: loadBool(STORAGE_KEYS.pasteProtection, true),
    autoReconnect: loadBool(STORAGE_KEYS.autoReconnect, false),
    sftpFollowCwd: loadBool(STORAGE_KEYS.sftpFollowCwd, true),
    workspaceRestore: loadBool(STORAGE_KEYS.workspaceRestore, true),
    completionNotify: loadBool(STORAGE_KEYS.completionNotify, true),
    highlightRules: loadHighlightRules(),
    shortcuts: loadShortcuts(),
    setActiveView: (view) => set({activeView: view}),
    setSettingsCategory: (category) => set({settingsCategory: category}),
    openSettingsSection: (category) => set({activeView: ViewType.Settings, settingsCategory: category}),
    toggleSidebar: () => set((state) => ({isSidebarVisible: !state.isSidebarVisible})),
    toggleFilePanel: () => set((state) => ({isFilePanelVisible: !state.isFilePanelVisible})),
    setFilePanelVisible: (visible) => set({isFilePanelVisible: visible}),
    toggleSnippetPanel: () => set((state) => ({isSnippetPanelVisible: !state.isSnippetPanelVisible})),
    setSnippetPanelVisible: (visible) => set({isSnippetPanelVisible: visible}),
    setCommandPaletteOpen: (open) => set({isCommandPaletteOpen: open}),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
    setDismissedUpdateVersion: (version) => set({ dismissedUpdateVersion: version }),
    setUpdateRelease: (version, url) => set({ updateReleaseVersion: version, updateReleaseUrl: url }),
    setTheme: (theme) => set({ theme }),
    setAccentColor: (color) => set({ accentColor: color }),
    setSpaciness: (s) => set({ spaciness: s }),
    setSkin: (skin) => set({ skin }),
    setTerminalColorLink: (enabled) => set({ terminalColorLink: enabled }),
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
    { value: "sky", labelKey: "accent_sky", color: "#60a5fa" },
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
