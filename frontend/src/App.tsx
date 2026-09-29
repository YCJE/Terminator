import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { ContentView } from "@/components/layout/ContentView";
import { LockScreen } from "@/components/views/LockScreen";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useAuthStore } from "@/store/authStore";
import { Events } from "@wailsio/runtime";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HOSTS_QUERY_KEY } from "@/hooks/useHosts.ts";
import { KEYS_QUERY_KEY } from "@/hooks/useKeys.ts";
import { SettingsService } from "../bindings/terminator-desktop/backend/internal/services/settings";
import { useTranslation } from "react-i18next";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore, Theme, AccentColor, Spaciness } from "@/store/uiStore.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { UpdaterService } from "../bindings/terminator-desktop/backend/internal/services/updater";

const VALID_ACCENTS: AccentColor[] = ["monochrome", "sky", "emerald", "violet", "amber", "rose", "cyan"];
const VALID_SPACINESS: Spaciness[] = [0.8, 1, 1.2];

export default function App() {
    const isUnlocked = useAuthStore((s) => s.isUnlocked);
    const markSessionDisconnected = useSessionStore((s) => s.markSessionDisconnected);
    const setUpdateVersionReady = useUIStore((s) => s.setUpdateVersionReady);
    const setUpdateRelease = useUIStore((s) => s.setUpdateRelease);
    const theme = useUIStore((s) => s.theme);
    const setTheme = useUIStore((s) => s.setTheme);
    const accentColor = useUIStore((s) => s.accentColor);
    const spaciness = useUIStore((s) => s.spaciness);
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

                // 恢复外观偏好 — 校验值合法性
                if (settings.accent_color && VALID_ACCENTS.includes(settings.accent_color as AccentColor)) {
                    setAccentColor(settings.accent_color as AccentColor);
                }
                if (settings.spaciness && settings.spaciness > 0 && VALID_SPACINESS.includes(settings.spaciness as Spaciness)) {
                    setSpaciness(settings.spaciness as Spaciness);
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

    // Apply accent color to document root whenever it changes
    useEffect(() => {
        document.documentElement.setAttribute("data-accent", accentColor);
    }, [accentColor]);

    // Apply spaciness to document root whenever it changes
    useEffect(() => {
        document.documentElement.style.setProperty("--spaciness", String(spaciness));
    }, [spaciness]);

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

    // 自动检查更新（cgo 禁用时 velopack 不可用，退回 GitHub Release 检查）
    const isCheckingRef = useRef(false);

    useEffect(() => {
        if (!isUnlocked) return;

        const checkUpdates = async () => {
            // 防止并发检查：上一次检查尚未完成时跳过
            if (isCheckingRef.current) return;
            // 实时读取 store 状态（非快照），避免在途状态变更不被感知
            const state = useUIStore.getState();
            if (state.updateVersionReady || state.updateReleaseUrl) return;

            isCheckingRef.current = true;
            try {
                const info = await UpdaterService.CheckForUpdates().catch(() => null);
                if (info?.isAvailable && info.version) {
                    // 重新读取 store，防止在途期间用户忽略了版本
                    const latest = useUIStore.getState();
                    if (latest.updateVersionReady) return;
                    if (latest.dismissedUpdateVersion === info.version) return;
                    await UpdaterService.DownloadUpdate().catch(console.debug);
                    setUpdateVersionReady(info.version);
                    return;
                }

                // 发布构建为 CGO_ENABLED=0，velopack 恒不可用，CheckForUpdates
                // 永远返回"无更新"。退回纯 Go 实现的 GitHub Release 检查，
                // 至少让用户知道有新版本并引导到下载页。
                const release = await UpdaterService.CheckGitHubReleases().catch(() => null);
                if (!release?.hasUpdate || !release.latestVersion || !release.htmlUrl) return;
                const latest = useUIStore.getState();
                if (latest.updateVersionReady || latest.updateReleaseUrl) return;
                if (latest.dismissedUpdateVersion === release.latestVersion) return;
                setUpdateRelease(release.latestVersion, release.htmlUrl);
            } finally {
                isCheckingRef.current = false;
            }
        };

        void checkUpdates();

        const interval = 5 * 60 * 1000; // 5 mins
        const intervalId = setInterval(() => {
            void checkUpdates();
        }, interval);

        return () => clearInterval(intervalId);
    }, [isUnlocked, setUpdateVersionReady, setUpdateRelease]);

    return (
        <ErrorBoundary>
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
        </ErrorBoundary>
    );
}
