// 标签组 / 会话快照：把当前标签组合与分屏布局命名保存，之后一键重新打开。
//
// 与工作区自动恢复一样，只保存主机 ID 与布局，不落盘密码、密钥等凭据；
// 打开快照时按主机当前配置重建会话，跳过需要交互输入密码的主机。

import { HostService, KeyService } from "../../bindings/terminator-desktop/backend/internal/services/blob";
import { buildSessionParams } from "@/lib/hostConnection";
import { capturePaneShape, countPanes, firstPaneSession, isPaneSession } from "@/lib/paneLayout";
import { parsePanesSnapshot, type WorkspacePanesSnapshot, type WorkspaceSplitSnapshot } from "@/lib/workspace";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType } from "@/store/uiStore";

export interface SessionSnapshot {
    id: string;
    name: string;
    /** 标签顺序（主机 ID 列表） */
    sessions: string[];
    activeHostId: string | null;
    /** 旧版单一分屏快照：仅为兼容历史数据保留 */
    split: WorkspaceSplitSnapshot | null;
    /** 多窗格布局快照；未分屏时为 null */
    panes: WorkspacePanesSnapshot | null;
    /** 保存时间戳（覆盖保存时更新） */
    savedAt: number;
}

/** 从当前会话状态提取可持久化的布局（不含名称与 ID） */
export function captureCurrentLayout(): Pick<SessionSnapshot, "sessions" | "activeHostId" | "split" | "panes"> {
    const state = useSessionStore.getState();
    const normal = state.sessions.filter((s) => !s.isSplitPane);
    const hostIds: string[] = [];
    for (const session of normal) {
        if (session.hostId && !hostIds.includes(session.hostId)) {
            hostIds.push(session.hostId);
        }
    }

    // 焦点在任一窗格时，激活标签对应布局代表会话
    const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
    const activePaneId = state.layout && activeSession
        && isPaneSession(state.layout, activeSession.id)
        ? firstPaneSession(state.layout)
        : activeSession?.id;
    const activeNormal = normal.find((s) => s.id === activePaneId);

    const layoutRoot = state.layout
        ? state.sessions.find((s) => s.id === firstPaneSession(state.layout))
        : undefined;
    const shape = state.layout ? capturePaneShape(state.layout) : null;

    return {
        sessions: hostIds,
        activeHostId: activeNormal?.hostId ?? null,
        split: null,
        panes: state.layout && layoutRoot?.hostId && shape && countPanes(state.layout) >= 2
            ? { hostId: layoutRoot.hostId, shape }
            : null,
    };
}

/** 打开快照：重建标签与分屏，返回成功恢复的标签数 */
export async function openSessionSnapshot(snapshot: SessionSnapshot): Promise<number> {
    const [hosts, keys] = await Promise.all([
        HostService.GetAll(),
        KeyService.GetAll(),
    ]);
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const keyIds = new Set(keys.map((k) => k.id));

    const restored = new Map<string, string>();
    for (const hostId of snapshot.sessions) {
        const host = hostById.get(hostId);
        if (!host) continue;
        const hasKey = !!host.keyId && keyIds.has(host.keyId);
        if (!host.password && !hasKey) continue;

        useSessionStore.getState().addSession(buildSessionParams(host, hosts, keys));
        const sessionId = useSessionStore.getState().activeSessionId;
        if (sessionId) restored.set(hostId, sessionId);
    }

    if (restored.size === 0) return 0;

    // 新版：按形状重建整组窗格；旧版快照仍按单一分屏恢复
    if (snapshot.panes) {
        const rootId = restored.get(snapshot.panes.hostId);
        if (rootId) {
            useSessionStore.getState().restorePaneLayout(rootId, snapshot.panes.shape);
        }
    } else if (snapshot.split) {
        const primaryId = restored.get(snapshot.split.hostId);
        if (primaryId) {
            useSessionStore.getState().setActiveSession(primaryId);
            useSessionStore.getState().splitActiveSession(snapshot.split.orientation);
        }
    }

    const activeId = snapshot.activeHostId ? restored.get(snapshot.activeHostId) : undefined;
    const targetId = activeId ?? restored.values().next().value;
    if (targetId) {
        useSessionStore.getState().setActiveSession(targetId);
    }
    useUIStore.getState().setActiveView(ViewType.Terminal);
    return restored.size;
}

const STORAGE_KEY = "terminator_session_snapshots_v1";

/** 校验并读取快照列表；损坏数据整体丢弃，不影响应用启动 */
export function loadSessionSnapshots(): SessionSnapshot[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const value = item as Partial<SessionSnapshot>;
            if (typeof value.id !== "string" || typeof value.name !== "string") return [];
            const sessions = Array.isArray(value.sessions)
                ? value.sessions.filter((id): id is string => typeof id === "string" && id.length > 0)
                : [];
            if (sessions.length === 0) return [];
            const split = value.split
                && typeof value.split.hostId === "string"
                && (value.split.orientation === "row" || value.split.orientation === "column")
                ? { hostId: value.split.hostId, orientation: value.split.orientation }
                : null;
            const panes = parsePanesSnapshot(value.panes);
            return [{
                id: value.id,
                name: value.name,
                sessions,
                activeHostId: typeof value.activeHostId === "string" ? value.activeHostId : null,
                split: panes ? null : split,
                panes,
                savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
            }];
        });
    } catch {
        return [];
    }
}

export function saveSessionSnapshots(list: SessionSnapshot[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // localStorage 不可用时静默忽略
    }
}
