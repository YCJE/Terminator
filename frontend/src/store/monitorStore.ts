import { create } from "zustand";
import type { MonitorSample } from "../../bindings/terminator-desktop/backend/internal/services/monitor/models";

/** 趋势图保留的采样点数：1s 间隔下约 2 小时，支撑 1/5/30 分钟时间范围切换 */
const HISTORY_LIMIT = 7200;

/** 单个采样点：只保留画图需要的汇总值，避免在内存里堆积完整样本 */
export interface MonitorHistoryPoint {
    /** Unix 毫秒 */
    t: number;
    cpu: number;
    mem: number;
    rxBps: number;
    txBps: number;
    readBps: number;
    writeBps: number;
}

export interface MonitorSessionState {
    /** 最新一帧完整采样，用于数值卡片 */
    sample: MonitorSample | null;
    /** 趋势图历史 */
    history: MonitorHistoryPoint[];
    /** 采集失败原因；有值时面板显示错误与重试 */
    error: string | null;
    /** 当前采样间隔 */
    intervalMS: number;
    /** 后端采集循环是否在运行 */
    running: boolean;
}

interface MonitorStoreState {
    sessions: Record<string, MonitorSessionState>;
    /** 收到一帧采样：更新最新值并追加历史点 */
    setSample: (sample: MonitorSample) => void;
    setError: (sessionId: string, message: string) => void;
    setRunning: (sessionId: string, running: boolean, intervalMS?: number) => void;
    /** 面板卸载时清理，避免重新打开看到过期数据 */
    resetSession: (sessionId: string) => void;
}

const EMPTY_STATE: MonitorSessionState = {
    sample: null,
    history: [],
    error: null,
    intervalMS: 1000,
    running: false,
};

/** 把一帧完整采样压缩成趋势图数据点 */
function toHistoryPoint(sample: MonitorSample): MonitorHistoryPoint {
    const network = sample.network ?? [];
    const disk = sample.disk ?? [];
    return {
        t: sample.timestamp,
        cpu: sample.cpu?.usage ?? 0,
        mem: sample.memory?.total ? (sample.memory.used / sample.memory.total) * 100 : 0,
        rxBps: network.reduce((sum, item) => sum + (item.rxBps ?? 0), 0),
        txBps: network.reduce((sum, item) => sum + (item.txBps ?? 0), 0),
        readBps: disk.reduce((sum, item) => sum + (item.readBps ?? 0), 0),
        writeBps: disk.reduce((sum, item) => sum + (item.writeBps ?? 0), 0),
    };
}

export const useMonitorStore = create<MonitorStoreState>((set) => ({
    sessions: {},

    setSample: (sample) => set((state) => {
        const id = sample.sessionId;
        if (!id) return state;
        const prev = state.sessions[id] ?? EMPTY_STATE;
        const history = [...prev.history, toHistoryPoint(sample)].slice(-HISTORY_LIMIT);
        return {
            sessions: {
                ...state.sessions,
                [id]: {
                    sample,
                    history,
                    error: null,
                    intervalMS: sample.intervalMs || prev.intervalMS,
                    running: true,
                },
            },
        };
    }),

    setError: (sessionId, message) => set((state) => {
        const prev = state.sessions[sessionId] ?? EMPTY_STATE;
        return {
            sessions: {
                ...state.sessions,
                // 保留最后一帧数据：连接中断时用户仍能看到断开前的状态
                [sessionId]: {...prev, error: message, running: false},
            },
        };
    }),

    setRunning: (sessionId, running, intervalMS) => set((state) => {
        const prev = state.sessions[sessionId] ?? EMPTY_STATE;
        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...prev,
                    running,
                    intervalMS: intervalMS ?? prev.intervalMS,
                    // 重新启动时清掉上一次的错误提示
                    error: running ? null : prev.error,
                },
            },
        };
    }),

    resetSession: (sessionId) => set((state) => {
        if (!state.sessions[sessionId]) return state;
        const next = {...state.sessions};
        delete next[sessionId];
        return {sessions: next};
    }),
}));
