import { create } from "zustand";

export enum ViewType {
    Hosts = "hosts",
    Keys = "keys",
    Settings = "settings",
    Terminal = "terminal",
}

export type Theme = "dark" | "light";

interface UIState {
    activeView: ViewType;
    isSidebarVisible: boolean;
    updateVersionReady: string | null;
    theme: Theme;
    setActiveView: (view: ViewType) => void;
    toggleSidebar: () => void;
    setUpdateVersionReady: (version: string | null) => void;
    setTheme: (theme: Theme) => void;
}

export const useUIStore = create<UIState>((set) => ({
    activeView: ViewType.Hosts,
    isSidebarVisible: true,
    updateVersionReady: null,
    theme: "dark",
    setActiveView: (view) => set({activeView: view}),
    toggleSidebar: () => set((state) => ({isSidebarVisible: !state.isSidebarVisible})),
    setUpdateVersionReady: (version) => set({ updateVersionReady: version }),
    setTheme: (theme) => set({ theme }),
}));