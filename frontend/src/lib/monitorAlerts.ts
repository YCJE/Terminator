// 服务器监控告警判定：阈值比较 + 连续采样计数 + 冷却时间。
//
// 判定逻辑与 React 组件分离，便于在事件回调里直接调用，也方便后续加单测。
// 连续计数意味着短暂尖峰不会打扰用户，只有持续超限才提醒。

import type { MonitorSample } from "../../bindings/terminator-desktop/backend/internal/services/monitor/models";

export type AlertMetric = "cpu" | "memory" | "disk";

export interface MonitorAlertThresholds {
    cpu: number;
    memory: number;
    disk: number;
}

export interface MetricBreach {
    metric: AlertMetric;
    /** 触发时的实际值（百分比） */
    value: number;
    threshold: number;
    /** 附加说明：磁盘告警时为挂载点 */
    detail?: string;
}

/** 同一会话同一指标的提醒冷却时间：持续超限时每 5 分钟最多提醒一次 */
export const ALERT_COOLDOWN_MS = 5 * 60_000;

/** 计算当前采样中超过阈值的指标（只看单帧数值，不含连续计数） */
export function detectBreaches(sample: MonitorSample, thresholds: MonitorAlertThresholds): MetricBreach[] {
    const breaches: MetricBreach[] = [];

    const cpu = sample.cpu?.usage ?? 0;
    if (cpu >= thresholds.cpu) {
        breaches.push({metric: "cpu", value: cpu, threshold: thresholds.cpu});
    }

    const memory = sample.memory;
    const memoryPercent = memory && memory.total > 0 ? (memory.used / memory.total) * 100 : 0;
    if (memoryPercent >= thresholds.memory) {
        breaches.push({metric: "memory", value: memoryPercent, threshold: thresholds.memory});
    }

    // 磁盘取使用率最高的挂载点：告警信息里带上挂载点更有指向性
    let worstUsage = 0;
    let worstMount = "";
    for (const item of sample.filesystems ?? []) {
        if (item.usagePercent > worstUsage) {
            worstUsage = item.usagePercent;
            worstMount = item.mount;
        }
    }
    if (worstUsage >= thresholds.disk) {
        breaches.push({
            metric: "disk",
            value: worstUsage,
            threshold: thresholds.disk,
            detail: worstMount,
        });
    }

    return breaches;
}

interface AlertTracker {
    /** 连续超阈值的采样次数 */
    streak: number;
    /** 上次提醒的时间戳（0 表示从未提醒） */
    lastTriggeredAt: number;
}

const trackers = new Map<string, AlertTracker>();

function trackerKey(sessionId: string, metric: AlertMetric): string {
    return `${sessionId}:${metric}`;
}

/**
 * 更新连续计数并返回本次需要提醒的指标。
 * - 连续 streakLimit 次超阈值才触发；
 * - 同一指标触发后进入 5 分钟冷却，持续超限期间到期再次提醒；
 * - 指标恢复正常的采样会清除计数，下次超限需重新累计。
 */
export function registerAlertBreaches(
    sessionId: string,
    breaches: MetricBreach[],
    streakLimit: number,
    now: number = Date.now(),
): MetricBreach[] {
    const triggered: MetricBreach[] = [];
    const breachMetrics = new Set<AlertMetric>();

    for (const breach of breaches) {
        breachMetrics.add(breach.metric);
        const key = trackerKey(sessionId, breach.metric);
        const tracker = trackers.get(key) ?? {streak: 0, lastTriggeredAt: 0};
        tracker.streak += 1;
        if (tracker.streak >= streakLimit && now - tracker.lastTriggeredAt >= ALERT_COOLDOWN_MS) {
            tracker.lastTriggeredAt = now;
            triggered.push(breach);
        }
        trackers.set(key, tracker);
    }

    // 恢复正常的指标：清掉连续计数，避免"累计计数"跨过多次短暂尖峰后误报
    const prefix = `${sessionId}:`;
    for (const key of Array.from(trackers.keys())) {
        if (!key.startsWith(prefix)) continue;
        const metric = key.slice(prefix.length) as AlertMetric;
        if (!breachMetrics.has(metric)) trackers.delete(key);
    }

    return triggered;
}

/** 清理指定会话的告警状态（关闭面板/会话断开时调用） */
export function resetAlertTrackers(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of Array.from(trackers.keys())) {
        if (key.startsWith(prefix)) trackers.delete(key);
    }
}
