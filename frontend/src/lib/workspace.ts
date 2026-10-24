// 工作区持久化：只保存可重建的会话标识与布局，不落盘任何凭据。
//
// 会话参数（密码、私钥、跳板链）可能随时间变化，恢复时一律按当前主机配置
// 重新构建；保存的只有主机 ID、标签顺序、激活标签与分屏方向。

import type { SplitOrientation } from "@/store/sessionStore";

const STORAGE_KEY = "terminator_workspace_v1";

export interface WorkspaceSplitSnapshot {
    /** 分屏主窗格对应的主机 ID */
    hostId: string;
    orientation: SplitOrientation;
}

export interface WorkspaceSnapshot {
    /** 标签顺序（仅普通标签，分屏副窗格不计入） */
    sessions: string[];
    /** 当前激活标签对应的主机 ID */
    activeHostId: string | null;
    /** 分屏信息；未分屏时为 null */
    split: WorkspaceSplitSnapshot | null;
}

/** 读取工作区快照；数据损坏或版本不符时返回 null。 */
export function loadWorkspace(): WorkspaceSnapshot | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot> | null;
        if (!parsed || !Array.isArray(parsed.sessions)) return null;
        const sessions = parsed.sessions.filter((id): id is string => typeof id === "string" && id.length > 0);
        if (sessions.length === 0) return null;

        const split = parsed.split
            && typeof parsed.split.hostId === "string"
            && (parsed.split.orientation === "row" || parsed.split.orientation === "column")
            ? { hostId: parsed.split.hostId, orientation: parsed.split.orientation }
            : null;

        return {
            sessions,
            activeHostId: typeof parsed.activeHostId === "string" ? parsed.activeHostId : null,
            split,
        };
    } catch {
        return null;
    }
}

export function saveWorkspace(snapshot: WorkspaceSnapshot): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
        // localStorage 不可用时静默忽略，不影响会话使用
    }
}

export function clearWorkspace(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 忽略
    }
}
