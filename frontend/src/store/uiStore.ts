import { create } from "zustand";

export enum ViewType {
    Hosts = "hosts",
    Keys = "keys",
    PortForwarding = "port-forwarding",
    Settings = "settings",
    Terminal = "terminal",
}

export type Theme = "dark" | "light";
export type AccentColor = "monochrome" | "sky" | "emerald" | "violet" | "amber" | "rose" | "cyan";
export type Spaciness = 0.8 | 1 | 1.2;

interface UIState {
    activeView: ViewType;
    isSidebarVisible: boolean;
    isFilePanelVisible: boolean;
    isSnippetPanelVisible: boolean;
    updateVersionReady: string | null;
    dismissedUpdateVersion: string | null;
    theme: Theme;
    accentColor: AccentColor;
    spaciness: Spaciness;
    terminalColorLink: boolean;
    /** 终端关键词高亮开关（前端纯本地设置，持久化到 localStorage） */
    keywordHighlight: boolean;
    setActiveView: (view: ViewType) => void;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    setFilePanelVisible: (visible: boolean) => void;
    toggleSnippetPanel: () => void;
    setSnippetPanelVisible: (visible: boolean) => void;
    setUpdateVersionReady: (version: string | null) => void;
    setDismissedUpdateVersion: (version: string | null) => void;
    setTheme: (theme: Theme) => void;
    setAccentColor: (color: AccentColor) => void;
    setSpaciness: (s: Spaciness) => void;
    setTerminalColorLink: (enabled: boolean) => void;
    setKeywordHighlight: (enabled: boolean) => void;
    /** 广播模式功能开关（控制广播按钮是否显示） */
    broadcastEnabled: boolean;
    toggleBroadcastEnabled: () => void;
    /** 标签页自定义颜色功能开关（控制右键颜色选择是否可用） */
    tabColorEnabled: boolean;
    toggleTabColorEnabled: () => void;
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
} as const;

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    isSidebarVisible: true,
    isFilePanelVisible: false,
    isSnippetPanelVisible: false,
    updateVersionReady: null,
    dismissedUpdateVersion: null,
    theme: "dark",
    accentColor: "monochrome",
    spaciness: 1,
    terminalColorLink: false,
    keywordHighlight: loadBool(STORAGE_KEYS.keywordHighlight, true),
    broadcastEnabled: loadBool(STORAGE_KEYS.broadcastEnabled, false),
    tabColorEnabled: loadBool(STORAGE_KEYS.tabColorEnabled, false),
    setActiveView: (view) => set({activeView: view}),
    toggleSidebar: () => set((state) => ({isSidebarVisible: !state.isSidebarVisible})),
    toggleFilePanel: () => set((state) => ({isFilePanelVisible: !state.isFilePanelVisible})),
    setFilePanelVisible: (visible) => set({isFilePanelVisible: visible}),
    toggleSnippetPanel: () => set((state) => ({isSnippetPanelVisible: !state.isSnippetPanelVisible})),
    setSnippetPanelVisible: (visible) => set({isSnippetPanelVisible: visible}),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
    setDismissedUpdateVersion: (version) => set({ dismissedUpdateVersion: version }),
    setTheme: (theme) => set({ theme }),
    setAccentColor: (color) => set({ accentColor: color }),
    setSpaciness: (s) => set({ spaciness: s }),
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
}));

/** 强调色预设列表，供设置页面渲染选择器 */
export const ACCENT_PRESETS: { value: AccentColor; label: string; color: string; colorDark?: string }[] = [
    { value: "monochrome", label: "默认", color: "#171717", colorDark: "#fafafa" },
    { value: "sky", label: "天蓝", color: "#60a5fa" },
    { value: "emerald", label: "翡翠绿", color: "#34d399" },
    { value: "violet", label: "紫罗兰", color: "#a78bfa" },
    { value: "amber", label: "琥珀橙", color: "#fbbf24" },
    { value: "rose", label: "玫瑰红", color: "#fb7185" },
    { value: "cyan", label: "青色", color: "#22d3ee" },
];

/** Spaciness 预设列表 */
export const SPACINESS_PRESETS: { value: Spaciness; label: string }[] = [
    { value: 0.8, label: "紧凑" },
    { value: 1, label: "标准" },
    { value: 1.2, label: "宽松" },
];
