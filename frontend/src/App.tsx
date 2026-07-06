import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { ContentView } from "@/components/layout/ContentView";
import { LockScreen } from "@/components/views/LockScreen";
import { Toaster } from "@/components/ui/sonner";
import { useAuthStore } from "@/store/authStore";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HOSTS_QUERY_KEY } from "@/hooks/useHosts.ts";
import { KEYS_QUERY_KEY } from "@/hooks/useKeys.ts";
import { SettingsService } from "../bindings/terminator-desktop/backend/internal/services/settings";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore, Theme } from "@/store/uiStore.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { UpdaterService } from "../bindings/terminator-desktop/backend/internal/services/updater";

export default function App() {
    const isUnlocked = useAuthStore((s) => s.isUnlocked);
    const markSessionDisconnected = useSessionStore((s) => s.markSessionDisconnected);
    const setUpdateVersionReady = useUIStore((s) => s.setUpdateVersionReady);
    const theme = useUIStore((s) => s.theme);
    const setTheme = useUIStore((s) => s.setTheme);
    const setAccentColor = useUIStore((s) => s.setAccentColor);
    const setSpaciness = useUIStore((s) => s.setSpaciness);
    const setTerminalColorLink = useUIStore((s) => s.setTerminalColorLink);
    const queryClient = useQueryClient();
    const {i18n} = useTranslation();

    useEffect(() => {
        SettingsService.GetSettings()
            .then((settings) => {
                if (settings.language && settings.language !== i18n.language) {
                    void i18n.changeLanguage(settings.language);
                } else if (!settings.language) {
                    // First launch: default to Chinese
                    void i18n.changeLanguage("zh");
                }

                // Apply theme: default to dark, validate value
                const raw = settings.theme;
                const savedTheme: Theme = raw === "light" || raw === "dark" ? raw : "dark";
                setTheme(savedTheme);

                // 恢复外观偏好
                if (settings.accent_color) {
                    setAccentColor(settings.accent_color);
                }
                if (settings.spaciness && settings.spaciness > 0) {
                    setSpaciness(settings.spaciness);
                }
                setTerminalColorLink(settings.terminal_color_link);
            })
            .catch(console.error);
    }, [i18n, setTheme, setAccentColor, setSpaciness, setTerminalColorLink]);

    // Apply theme class to document root whenever it changes
    useEffect(() => {
        const root = document.documentElement;
        if (theme === "light") {
            root.classList.remove("dark");
        } else {
            root.classList.add("dark");
        }
    }, [theme]);

    // SSH 会话断开：标记为已断开（不自动移除标签），让用户决定是否关闭
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshClosed, (event) => {
            const data = event?.data as { id?: string } | null;
            if (!data?.id) return;
            markSessionDisconnected(data.id);
        });

        return () => unsubscribe();
    }, [markSessionDisconnected]);

    useEffect(() => {
        if (!isUnlocked) return;

        const unsubscribe = Events.On(AppEvent.SyncUpdatesAvailable, () => {
            console.debug(`${AppEvent.SyncUpdatesAvailable}: invalidating queries`);

            void queryClient.invalidateQueries({queryKey: HOSTS_QUERY_KEY});
            void queryClient.invalidateQueries({queryKey: KEYS_QUERY_KEY});
        });

        return () => unsubscribe();
    }, [isUnlocked, queryClient]);

    // 自动检查更新（cgo 禁用时会静默失败，不影响使用）
    useEffect(() => {
        if (!isUnlocked) return;

        const checkUpdates = () => {
            UpdaterService.CheckForUpdates()
                .then((info) => {
                    if (info?.isAvailable) {
                        UpdaterService.DownloadUpdate()
                            .then(() => setUpdateVersionReady(info.version))
                            .catch(console.debug);
                    }
                })
                .catch(() => {
                    // cgo 禁用或更新服务不可用时静默忽略
                });
        };

        checkUpdates();

        const interval = 5 * 60 * 1000; // 5 mins
        const intervalId = setInterval(checkUpdates, interval);

        return () => clearInterval(intervalId);
    }, [isUnlocked, setUpdateVersionReady]);

    return (
        <div className="app-shell flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
            <TitleBar/>
            <div className="flex flex-1 overflow-hidden relative">

                {!isUnlocked ? (
                    <LockScreen/>
                ) : (
                    <>
                        <Sidebar/>
                        <ContentView/>
                    </>
                )}

            </div>
            <Toaster position="bottom-right" theme={theme} richColors style={{ zIndex: 9999 }} />
        </div>
    );
}