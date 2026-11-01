import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { WorkspaceManager } from "@/components/layout/WorkspaceManager";
import { PortForwardRestorer } from "@/components/layout/PortForwardRestorer";
import { ContentView } from "@/components/layout/ContentView";
import { SyncConflictBanner } from "@/components/layout/SyncConflictBanner";
import { LockScreen } from "@/components/views/LockScreen";
import { AuthPromptDialog } from "@/components/views/AuthPromptDialog";
import { QuickConnectDialog } from "@/components/views/QuickConnectDialog";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useAuthStore } from "@/store/authStore";
import { Events } from "@wailsio/runtime";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HOSTS_QUERY_KEY } from "@/hooks/useHosts.ts";
import { KEYS_QUERY_KEY } from "@/hooks/useKeys.ts";
import { AppEvent } from "@/lib/events.ts";
import { useUIStore } from "@/store/uiStore.ts";
import { useSessionStore } from "@/store/sessionStore.ts";
import { useSyncStore } from "@/store/syncStore.ts";
import { UpdaterService } from "../bindings/terminator-desktop/backend/internal/services/updater";
import { AuthService } from "../bindings/terminator-desktop/backend/internal/services/auth";
import { applyAppearanceToDocument, syncAppearanceFromSettings } from "@/lib/appAppearance";
import { adoptDockedSession } from "@/lib/floatingWindows";
import type { FloatingDockData } from "@/lib/floatingWindows";

export default function App() {
    const isUnlocked = useAuthStore((s) => s.isUnlocked);
    const markSessionDisconnected = useSessionStore((s) => s.markSessionDisconnected);
    const refreshConflicts = useSyncStore((s) => s.refreshConflicts);
    const setConflictCount = useSyncStore((s) => s.setConflictCount);
    const setUpdateVersionReady = useUIStore((s) => s.setUpdateVersionReady);
    const setUpdateRelease = useUIStore((s) => s.setUpdateRelease);
    const theme = useUIStore((s) => s.theme);
    const accentColor = useUIStore((s) => s.accentColor);
    const spaciness = useUIStore((s) => s.spaciness);
    const skin = useUIStore((s) => s.skin);
    const autoLockMinutes = useUIStore((s) => s.autoLockMinutes);
    const isQuickConnectOpen = useUIStore((s) => s.isQuickConnectOpen);
    const setQuickConnectOpen = useUIStore((s) => s.setQuickConnectOpen);
    const setUnlocked = useAuthStore((s) => s.setUnlocked);
    const clearSessions = useSessionStore((s) => s.clearSessions);
    const queryClient = useQueryClient();

    // 外观设置由 lib/appAppearance 统一同步，浮动窗口使用同一套逻辑
    useEffect(() => {
        void syncAppearanceFromSettings().catch(console.error);
    }, []);

    // 皮肤自带明暗属性：HUD 强制暗、编辑纸感强制亮；default 时跟随 theme。
    // 这样强调色预设能取到正确的明暗变体（见 main.css 皮肤层说明）。
    const effectiveDark = skin === "hud" ? true : skin === "editorial" ? false : theme === "dark";

    // 主题/皮肤/强调色/密度变化时同步到 document 根元素
    useEffect(() => {
        applyAppearanceToDocument();
    }, [theme, accentColor, spaciness, skin]);

    // SSH 会话断开：标记为已断开（不自动移除标签），让用户决定是否关闭
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshClosed, (event) => {
            const data = event?.data as { id?: string } | null;
            if (!data?.id) return;
            // 重连时旧连接的 Disconnect 也会发一次 closed。会话处于 connecting
            // 说明新连接仍在建立，此时标记断开会让 TerminalInstance 的
            // disconnected effect 重新排一轮重连。该事件的实例内守卫见
            // TerminalInstance，这里保持同样语义，避免全局处理器绕过它。
            const session = useSessionStore.getState().sessions.find((s) => s.id === data.id);
            if (session?.status === "connecting") return;
            markSessionDisconnected(data.id);
        });

        return () => unsubscribe();
    }, [markSessionDisconnected]);

    // 浮动窗口请求回到标签栏：以原会话 ID 附着，后端连接保持不动
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.FloatingDock, (event) => {
            const data = event?.data as FloatingDockData | null;
            if (!data?.sessionId) return;
            adoptDockedSession(data);
        });
        return () => unsubscribe();
    }, []);

    // 空闲自动锁屏
    // 仅在"已解锁 + 用户设置了分钟数"时生效；任何键鼠/滚轮/触摸活动都会重置计时，
    // 触发时与命令面板的"锁定"保持一致：先让后端锁定密钥库，再断开全部会话并清缓存，
    // 避免锁屏后内存里仍留着已解密的凭据。
    useEffect(() => {
        if (!isUnlocked || autoLockMinutes <= 0) return;

        let timer: ReturnType<typeof setTimeout> | null = null;
        const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                // 到时再确认一次：用户可能已手动锁定，或已在设置里关闭了自动锁屏
                const ui = useUIStore.getState();
                if (!useAuthStore.getState().isUnlocked || ui.autoLockMinutes <= 0) return;
                AuthService.LockVault()
                    .then(() => {
                        clearSessions();
                        queryClient.clear();
                        setUnlocked(false);
                    })
                    .catch((err) => console.error("auto lock failed", err));
            }, autoLockMinutes * 60_000);
        };
        arm();

        const events: (keyof WindowEventMap)[] = [
            "mousedown",
            "keydown",
            "wheel",
            "touchstart",
            "mousemove",
        ];
        // mousemove 触发极频繁，节流到 1 秒一次即可，避免反复清除/重建定时器
        let lastReset = 0;
        const onActivity = () => {
            const now = Date.now();
            if (now - lastReset < 1000) return;
            lastReset = now;
            arm();
        };
        events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
        return () => {
            if (timer) clearTimeout(timer);
            events.forEach((ev) => window.removeEventListener(ev, onActivity));
        };
    }, [isUnlocked, autoLockMinutes, clearSessions, queryClient, setUnlocked]);

    // 解锁后拉取一次冲突数量用于全局提示；锁定时清零，避免残留徽标
    useEffect(() => {
        if (!isUnlocked) {
            setConflictCount(0);
            return;
        }
        void refreshConflicts();
    }, [isUnlocked, refreshConflicts, setConflictCount]);

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
                    // "稍后提醒"仅本次运行有效；"跳过此版本"已持久化到 localStorage
                    if (latest.updateSnoozedForSession) return;
                    if (latest.dismissedUpdateVersion === info.version) return;
                    // 仅在下载真正成功后标记为"就绪"。若吞掉下载错误仍标记就绪，
                    // UI 会提示"重启以更新"，但 ApplyAndRestart 会因状态不是已下载
                    // 而报错（update not downloaded yet），属于误报。
                    try {
                        await UpdaterService.DownloadUpdate();
                    } catch (err) {
                        console.debug("update download failed", err);
                        return;
                    }
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
                if (latest.updateSnoozedForSession) return;
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
            <div className="app-shell flex h-screen w-screen flex-col overflow-hidden bg-[var(--surface-0)] text-[var(--fg-strong)]">
                <TitleBar/>
                {isUnlocked && <SyncConflictBanner/>}
                <div className="flex flex-1 overflow-hidden relative">

                    {!isUnlocked ? (
                        <LockScreen/>
                    ) : (
                        <>
                            <Sidebar/>
                            <ContentView/>
                            <CommandPalette/>
                            <WorkspaceManager/>
                            {/* 会话连上后按主机自动恢复持久化的端口转发 */}
                            <PortForwardRestorer/>
                            <QuickConnectDialog
                                isOpen={isQuickConnectOpen}
                                onClose={() => setQuickConnectOpen(false)}
                            />
                            {/* 交互式认证（MFA/OTP）：服务器在连接阶段要求输入时弹出 */}
                            <AuthPromptDialog/>
                        </>
                    )}

                </div>
                <Toaster
                    position="bottom-right"
                    theme={effectiveDark ? "dark" : "light"}
                    richColors
                    // 抬高到状态条之上：否则传输/连接提示会盖住底部状态栏
                    offset={{ bottom: 36, right: 14 }}
                    style={{ zIndex: 9999 }}
                />
            </div>
        </ErrorBoundary>
    );
}
