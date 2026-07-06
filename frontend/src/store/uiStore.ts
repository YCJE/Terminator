import { create } from "zustand";

export enum ViewType {
    Hosts = "hosts",
    Keys = "keys",
    Settings = "settings",
    Terminal = "terminal",
}

export type Theme = "dark" | "light";
export type AccentColor = "sky" | "emerald" | "violet" | "amber" | "rose" | "cyan";
export type Spaciness = 0.8 | 1 | 1.2;

interface UIState {
    activeView: ViewType;
    isSidebarVisible: boolean;
    isFilePanelVisible: boolean;
    updateVersionReady: string | null;
    theme: Theme;
    accentColor: AccentColor;
    spaciness: Spaciness;
    terminalColorLink: boolean;
    setActiveView: (view: ViewType) => void;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    setFilePanelVisible: (visible: boolean) => void;
    setUpdateVersionReady: (version: string | null) => void;
    setTheme: (theme: Theme) => void;
    setAccentColor: (color: AccentColor) => void;
    setSpaciness: (s: Spaciness) => void;
    setTerminalColorLink: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    isSidebarVisible: true,
    isFilePanelVisible: false,
    updateVersionReady: null,
    theme: "dark",
    accentColor: "sky",
    spaciness: 1,
    terminalColorLink: false,
    setActiveView: (view) => set({activeView: view}),
    toggleSidebar: () => set((state) => ({isSidebarVisible: !state.isSidebarVisible})),
    toggleFilePanel: () => set((state) => ({isFilePanelVisible: !state.isFilePanelVisible})),
    setFilePanelVisible: (visible) => set({isFilePanelVisible: visible}),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
    setTheme: (theme) => set({ theme }),
    setAccentColor: (color) => set({ accentColor: color }),
    setSpaciness: (s) => set({ spaciness: s }),
    setTerminalColorLink: (enabled) => set({ terminalColorLink: enabled }),
}));

/** 强调色预设列表，供设置页面渲染选择器 */
export const ACCENT_PRESETS: { value: AccentColor; label: string; color: string }[] = [
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
