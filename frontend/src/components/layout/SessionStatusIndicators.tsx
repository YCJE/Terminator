// 会话状态指示器：连接延迟徽标 + 服务器资源小面板
// 两者都只能在后端已有活跃 SSH 会话时使用，断开/连接中不显示或给出提示。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import type { SystemStats } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 延迟采样间隔：10 秒一次，复用 SSH keepalive 请求，不产生远端命令开销 */
const LATENCY_INTERVAL_MS = 10_000;
/** 资源采样间隔：面板打开期间每 5 秒刷新一次 */
const STATS_INTERVAL_MS = 5_000;

interface SessionIndicatorProps {
    sessionId: string | null;
}

/** 连接延迟徽标：按阈值着色，测量失败显示占位符 */
export function LatencyBadge({ sessionId }: SessionIndicatorProps) {
    const { t } = useTranslation("terminal");
    const [latency, setLatency] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setLatency(null);
        setFailed(false);
        if (!sessionId) return;

        let cancelled = false;
        const measure = async () => {
            try {
                const ms = await SshService.GetLatency(sessionId);
                if (cancelled) return;
                setLatency(ms);
                setFailed(false);
            } catch {
                if (!cancelled) setFailed(true);
            }
        };
        measure();
        const timer = setInterval(measure, LATENCY_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [sessionId]);

    if (!sessionId) return null;

    const label = failed
        ? t("latency_unknown")
        : latency === null
            ? t("latency_measuring")
            : t("latency_label", { ms: latency });

    return (
        <span
            className={cn(
                "wails-no-drag shrink-0 select-none font-mono text-[11px] tabular-nums",
                failed || latency === null
                    ? "text-[var(--fg-subtle)]"
                    : latency < 80
                        ? "text-[var(--fg-muted)]"
                        : latency < 200
                            ? "text-warning"
                            : "text-destructive"
            )}
            title={t("latency_tip")}
        >
            {label}
        </span>
    );
}

/** 把秒数格式化为「天/时/分」 */
function formatUptime(seconds: number, t: TFunction): string {
    if (seconds <= 0) return "—";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return t("uptime_days", { days, hours });
    if (hours > 0) return t("uptime_hours", { hours, minutes });
    return t("uptime_minutes", { minutes });
}

/** 趋势采样上限：5 秒一次，约保留最近 2 分钟 */
const HISTORY_LIMIT = 24;

/** 迷你趋势图：把一串数值归一化后画成折线，用于观察内存与负载变化 */
function Sparkline({ values, max, className }: { values: number[]; max?: number; className?: string }) {
    if (values.length < 2) return <div className={cn("h-4", className)} />;
    const top = Math.max(max ?? 0, ...values, 1);
    const points = values
        .map((value, index) => {
            const x = (index / (values.length - 1)) * 100;
            const y = 15 - Math.min(1, Math.max(0, value / top)) * 14;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    return (
        <svg
            viewBox="0 0 100 16"
            preserveAspectRatio="none"
            className={cn("h-4 w-full", className)}
            aria-hidden
        >
            <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/** 百分比进度条（内存/磁盘占用） */
function UsageBar({ used, total }: { used: number; total: number }) {
    const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
            <div
                className={cn(
                    "h-full rounded-full transition-[width] duration-300",
                    percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-primary"
                )}
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}

/** 服务器资源小面板：打开期间轮询一次轻量采样 */
export function SystemStatsButton({ sessionId }: SessionIndicatorProps) {
    const { t } = useTranslation("terminal");
    const [open, setOpen] = useState(false);
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [failed, setFailed] = useState(false);
    // 内存占用百分比与 1 分钟负载的历史采样，用于画迷你趋势图
    const [memHistory, setMemHistory] = useState<number[]>([]);
    const [loadHistory, setLoadHistory] = useState<number[]>([]);
    // 单次采样最长 4 秒，与 5 秒轮询间隔接近：上一轮未返回时跳过本轮，
    // 避免响应乱序把较旧的数据追加到趋势图末尾
    const inFlightRef = useRef(false);

    useEffect(() => {
        if (!open || !sessionId) return;
        let cancelled = false;
        const load = async () => {
            if (inFlightRef.current) return;
            inFlightRef.current = true;
            try {
                const result = await SshService.GetSystemStats(sessionId);
                if (cancelled) return;
                setStats(result);
                setFailed(!result);
                if (result && result.supported) {
                    const memPercent = result.memTotal > 0 ? (result.memUsed / result.memTotal) * 100 : 0;
                    setMemHistory((prev) => [...prev, memPercent].slice(-HISTORY_LIMIT));
                    setLoadHistory((prev) => [...prev, result.load1].slice(-HISTORY_LIMIT));
                }
            } catch {
                if (!cancelled) setFailed(true);
            } finally {
                inFlightRef.current = false;
            }
        };
        load();
        const timer = setInterval(load, STATS_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [open, sessionId]);

    // 关闭面板或切换会话时清空旧数据：否则会在新主机上展示上一个主机的
    // 数值，趋势图也会把两台主机的采样拼成同一条曲线
    useEffect(() => {
        setStats(null);
        setFailed(false);
        setMemHistory([]);
        setLoadHistory([]);
    }, [open, sessionId]);

    if (!sessionId) return null;

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="wails-no-drag text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                    title={t("stats_title")}
                >
                    <Activity className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--fg-subtle)]">
                    {t("stats_title")}
                </div>

                {failed ? (
                    <div className="py-1 text-xs text-[var(--fg-muted)]">{t("stats_failed")}</div>
                ) : !stats ? (
                    <div className="py-1 text-xs text-[var(--fg-muted)]">{t("stats_loading")}</div>
                ) : !stats.supported ? (
                    <div className="py-1 text-xs text-[var(--fg-muted)]">{t("stats_unsupported")}</div>
                ) : (
                    <div className="flex flex-col gap-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--fg-subtle)]">{t("stats_os")}</span>
                            <span className="truncate font-mono text-[var(--fg-strong)]">{stats.os || "—"}</span>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[var(--fg-subtle)]">{t("stats_load")}</span>
                                <span className="font-mono tabular-nums text-[var(--fg-strong)]">
                                    {stats.load1.toFixed(2)} / {stats.load5.toFixed(2)} / {stats.load15.toFixed(2)}
                                </span>
                            </div>
                            <div className="mt-0.5 flex items-center justify-between gap-2">
                                <span className="text-[10px] text-[var(--fg-subtle)]">
                                    {stats.cpuCount > 0 ? t("stats_cores", { count: stats.cpuCount }) : "—"}
                                </span>
                                <div className="w-24 text-[var(--fg-subtle)]">
                                    <Sparkline values={loadHistory} max={Math.max(stats.cpuCount, 1)} />
                                </div>
                            </div>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[var(--fg-subtle)]">{t("stats_memory")}</span>
                                <span className="font-mono tabular-nums text-[var(--fg-strong)]">
                                    {formatFileSize(stats.memUsed)} / {formatFileSize(stats.memTotal)}
                                </span>
                            </div>
                            <UsageBar used={stats.memUsed} total={stats.memTotal}/>
                            <div className="mt-0.5 text-[var(--fg-subtle)]">
                                <Sparkline values={memHistory} max={100}/>
                            </div>
                        </div>
                        {stats.swapTotal > 0 && (
                            <div>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[var(--fg-subtle)]">{t("stats_swap")}</span>
                                    <span className="font-mono tabular-nums text-[var(--fg-strong)]">
                                        {formatFileSize(stats.swapUsed)} / {formatFileSize(stats.swapTotal)}
                                    </span>
                                </div>
                                <UsageBar used={stats.swapUsed} total={stats.swapTotal}/>
                            </div>
                        )}
                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[var(--fg-subtle)]">{t("stats_disk")}</span>
                                <span className="font-mono tabular-nums text-[var(--fg-strong)]">
                                    {formatFileSize(stats.diskUsed)} / {formatFileSize(stats.diskTotal)}
                                </span>
                            </div>
                            <UsageBar used={stats.diskUsed} total={stats.diskTotal}/>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--fg-subtle)]">{t("stats_uptime")}</span>
                            <span className="font-mono tabular-nums text-[var(--fg-strong)]">
                                {formatUptime(stats.uptimeSeconds, t)}
                            </span>
                        </div>
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
