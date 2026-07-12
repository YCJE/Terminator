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
}

// ---- 关键词高亮设置的 localStorage 持久化 ----
// 由于此功能为纯前端特性（不涉及后端），使用 localStorage 独立持久化
const KEYWORD_HIGHLIGHT_STORAGE_KEY = 'terminator_keyword_highlight';

/** 从 localStorage 读取关键词高亮初始值，默认开启 */
function loadKeywordHighlight(): boolean {
    try {
        const stored = localStorage.getItem(KEYWORD_HIGHLIGHT_STORAGE_KEY);
        // 未存储时默认为 true（开启），存储值为 'false' 时关闭
        return stored !== 'false';
    } catch {
        // localStorage 不可用时默认开启
        return true;
    }
}

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
    keywordHighlight: loadKeywordHighlight(),
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
        // 持久化到 localStorage，刷新后保持设置
        try {
            localStorage.setItem(KEYWORD_HIGHLIGHT_STORAGE_KEY, String(enabled));
        } catch {
            // localStorage 不可用时静默忽略
        }
        set({ keywordHighlight: enabled });
    },
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
