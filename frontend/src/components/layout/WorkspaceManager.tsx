// 工作区恢复：应用解锁后按上次的标签顺序与分屏布局重建会话。
//
// 恢复是"尽力而为"：只重建仍存在且具备非交互认证（已保存密码或可用密钥）的主机；
// 需要每次输入密码的主机会被跳过，避免解锁后弹出一连串密码框。

import { useEffect, useRef } from "react";
import { HostService, KeyService } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { buildSessionParams } from "@/lib/hostConnection";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "@/lib/workspace";
import { captureCurrentLayout } from "@/lib/sessionSnapshots";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";
import { useAuthStore } from "@/store/authStore";

/** 每次应用启动只尝试恢复一次；锁定/解锁不会重复打开上次的会话。 */
let restoreStarted = false;

/** 恢复流程进行中时不得清理空快照：异步恢复可能还没建出会话。 */
let restoreInProgress = false;

export function WorkspaceManager() {
    const restoredRef = useRef(false);

    // 解锁后恢复一次工作区
    useEffect(() => {
        if (restoredRef.current || restoreStarted) return;
        restoredRef.current = true;
        restoreStarted = true;

        if (!useUIStore.getState().workspaceRestore) return;
        const snapshot = loadWorkspace();
        if (!snapshot) return;

        let cancelled = false;
        restoreInProgress = true;
        (async () => {
            const [hosts, keys] = await Promise.all([
                HostService.GetAll(),
                KeyService.GetAll(),
            ]);
            if (cancelled) return;

            const hostById = new Map(hosts.map((h) => [h.id, h]));
            const keyIds = new Set(keys.map((k) => k.id));

            // hostID → 新建的会话 ID；只有具备非交互认证的主机才会被恢复
            const restored = new Map<string, string>();
            for (const hostId of snapshot.sessions) {
                // 锁定/退出时组件卸载会置 cancelled：若继续 addSession，
                // 会在 clearSessions 之后又建出一批"锁定状态下"的标签页
                if (cancelled) return;
                const host = hostById.get(hostId);
                if (!host) continue;
                const hasKey = !!host.keyId && keyIds.has(host.keyId);
                if (!host.password && !hasKey) continue;

                useSessionStore.getState().addSession(buildSessionParams(host, hosts, keys));
                const sessionId = useSessionStore.getState().activeSessionId;
                if (sessionId) restored.set(hostId, sessionId);
            }

            if (cancelled || restored.size === 0) return;

            // 恢复分屏：先聚焦主窗格再拆分，最后切回原来的激活标签
            if (snapshot.split) {
                const primaryId = restored.get(snapshot.split.hostId);
                if (primaryId) {
                    useSessionStore.getState().setActiveSession(primaryId);
                    useSessionStore.getState().splitActiveSession(snapshot.split.orientation);
                }
            }

            const activeId = snapshot.activeHostId
                ? restored.get(snapshot.activeHostId)
                : undefined;
            const targetId = activeId ?? restored.values().next().value;
            if (targetId) {
                useSessionStore.getState().setActiveSession(targetId);
            }
            useUIStore.getState().setActiveView(ViewType.Terminal);
        })().catch((err) => {
            console.error("恢复工作区失败:", err);
        }).finally(() => {
            restoreInProgress = false;
        });

        return () => {
            cancelled = true;
            restoreInProgress = false;
        };
    }, []);

    // 会话/布局变化时持久化；空工作区延迟清除，避免锁定流程误删快照
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const buildSnapshot = () => captureCurrentLayout();

        const persist = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const snapshot = buildSnapshot();
            if (snapshot.sessions.length > 0) {
                saveWorkspace(snapshot);
                return;
            }
            // 空工作区可能是"关闭了所有标签"，也可能是锁定时的批量清理。
            // 延迟清除，锁定导致组件卸载时定时器会被取消，快照得以保留。
            timer = setTimeout(() => {
                timer = null;
                // 恢复尚未结束时保留快照，否则下次启动会丢失上次布局
                if (restoreInProgress) return;
                const state = useSessionStore.getState();
                if (useAuthStore.getState().isUnlocked && state.sessions.length === 0) {
                    clearWorkspace();
                }
            }, 4000);
        };

        const unsubscribe = useSessionStore.subscribe(persist);
        // 关闭窗口前立即落盘，避免最后一次布局变更还在防抖窗口内
        const handleBeforeUnload = () => {
            const snapshot = buildSnapshot();
            if (snapshot.sessions.length > 0) saveWorkspace(snapshot);
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        persist();

        return () => {
            unsubscribe();
            window.removeEventListener("beforeunload", handleBeforeUnload);
            if (timer) clearTimeout(timer);
        };
    }, []);

    return null;
}
