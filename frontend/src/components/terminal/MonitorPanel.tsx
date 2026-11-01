import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Dialogs, Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import {
    Activity,
    Cpu,
    Download,
    Gauge,
    Gpu,
    HardDrive,
    Info,
    ListTree,
    MemoryStick,
    Network,
    RotateCw,
    Skull,
    TriangleAlert,
    X,
} from "lucide-react";
import { MonitorService } from "../../../bindings/terminator-desktop/backend/internal/services/monitor";
import type {
    GPUStat,
    MonitorSample,
    ProcessStat,
} from "../../../bindings/terminator-desktop/backend/internal/services/monitor/models";
import { TextFileService } from "../../../bindings/terminator-desktop/backend/internal/services/fileio";
import { useMonitorStore, type MonitorHistoryPoint } from "@/store/monitorStore";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { isSshKind } from "@/lib/sessionBackend";
import { MONITOR_ERROR_EVENT, MONITOR_SAMPLE_EVENT } from "@/lib/monitorEvents";
import { detectBreaches, registerAlertBreaches, resetAlertTrackers, type AlertMetric } from "@/lib/monitorAlerts";
import { showDesktopNotification } from "@/lib/desktopNotify";
import { parseAppError } from "@/lib/error";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

/** 可调刷新间隔；与后端 [500, 30000] 的取值区间对齐 */
const INTERVAL_OPTIONS = [1000, 2000, 5000, 10000] as const;
const INTERVAL_STORAGE_KEY = "terminator_monitor_interval";

/** 趋势时间范围（分钟）：与 TermX 的 1/5/30 分钟对齐 */
const RANGE_OPTIONS = [1, 5, 30] as const;
const RANGE_STORAGE_KEY = "terminator_monitor_range";
/** 折线最多渲染的点数：范围再大也只做降采样，避免 SVG 过密 */
const RANGE_RENDER_POINTS = 120;

function loadInterval(): number {
    try {
        const raw = Number(localStorage.getItem(INTERVAL_STORAGE_KEY));
        return INTERVAL_OPTIONS.includes(raw as (typeof INTERVAL_OPTIONS)[number]) ? raw : 1000;
    } catch {
        return 1000;
    }
}

function loadRange(): number {
    try {
        const raw = Number(localStorage.getItem(RANGE_STORAGE_KEY));
        return RANGE_OPTIONS.includes(raw as (typeof RANGE_OPTIONS)[number]) ? raw : 1;
    } catch {
        return 1;
    }
}

/**
 * 按时间范围截取历史并降采样。
 * 采样间隔可配置，30 分钟在 500ms 间隔下会积累 3600 点；
 * 按等间隔抽稀到 120 点即可保持趋势形状，又不会让 SVG 路径过长。
 */
function selectRange<T extends {t: number}>(history: T[], minutes: number): T[] {
    const cutoff = Date.now() - minutes * 60_000;
    const filtered = history.filter((point) => point.t >= cutoff);
    if (filtered.length <= RANGE_RENDER_POINTS) return filtered;
    const stride = Math.ceil(filtered.length / RANGE_RENDER_POINTS);
    const sampled: T[] = [];
    for (let i = 0; i < filtered.length; i += stride) sampled.push(filtered[i]);
    const last = filtered[filtered.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled;
}

/** 空历史数组的稳定引用：避免每次渲染都创建新数组导致选择器抖动 */
const EMPTY_HISTORY: never[] = [];

/** 文件名片段安全化：过滤 Windows 非法字符并限长 */
function safeFilePart(value: string, fallback: string): string {
    const clean = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().slice(0, 40);
    return clean || fallback;
}

/** 导出文件名的时间戳（本地时区），避免连续导出互相覆盖 */
function fileStamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * 历史趋势导出为 CSV。
 * 同时写入 ISO 时间与毫秒时间戳：前者便于表格软件直接识别时间轴，
 * 后者在与日志等其他数据源对齐时无需再做时区换算。速率取整，
 * 避免浮点值以科学计数法写入后难以阅读。
 */
function historyToCsv(points: MonitorHistoryPoint[]): string {
    const header = "time, timestamp_ms, cpu_percent, memory_percent, rx_bytes_per_sec, tx_bytes_per_sec, "
        + "disk_read_bytes_per_sec, disk_write_bytes_per_sec";
    const rows = points.map((point) => [
        new Date(point.t).toISOString(),
        point.t,
        point.cpu.toFixed(1),
        point.mem.toFixed(1),
        Math.round(point.rxBps),
        Math.round(point.txBps),
        Math.round(point.readBps),
        Math.round(point.writeBps),
    ].join(","));
    return [header, ...rows].join("\n");
}

/** 比较两次超限指标集合是否一致，避免每帧都触发一次额外的状态更新 */
function sameAlertMetrics(a: AlertMetric[], b: AlertMetric[]): boolean {
    return a.length === b.length && a.every((metric, index) => metric === b[index]);
}

/**
 * 串行化监控启停命令
 * Wails 的多个 IPC 调用不保证按发起顺序到达后端。切换刷新间隔或断开重连时
 * 会先发 Stop 再发 Start，若顺序颠倒，Start 新建的循环会被后到的 Stop 立即停掉。
 * 用模块级 Promise 链保证后端始终按调用顺序执行"先停后启"。
 */
let monitorCommandChain: Promise<void> = Promise.resolve();

function enqueueMonitorCommand(command: () => Promise<void>): void {
    monitorCommandChain = monitorCommandChain.then(command).catch(() => {});
}

/**
 * 服务器监控面板
 * 与 SFTP 文件面板互斥地占满右侧同一条侧栏位置。采集由后端按会话启动，
 * 面板只负责展示与调节刷新间隔；关闭面板或会话断开即停止采集。
 */
export function MonitorPanel({sessionId}: {sessionId: string}) {
    const {t} = useTranslation("terminal");
    const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId));
    const [intervalMS, setIntervalMS] = useState(loadInterval);
    const [rangeMinutes, setRangeMinutes] = useState(loadRange);
    const [retryNonce, setRetryNonce] = useState(0);
    // 当前超过阈值的指标：用于面板卡片高亮
    const [activeAlerts, setActiveAlerts] = useState<AlertMetric[]>([]);
    // 待确认终止的进程（null 表示对话框关闭）
    const [killTarget, setKillTarget] = useState<ProcessStat | null>(null);
    const [killBusy, setKillBusy] = useState(false);
    const [exporting, setExporting] = useState(false);

    const sample = useMonitorStore((s) => s.sessions[sessionId]?.sample ?? null);
    const history = useMonitorStore((s) => s.sessions[sessionId]?.history ?? EMPTY_HISTORY);
    const error = useMonitorStore((s) => s.sessions[sessionId]?.error ?? null);
    const running = useMonitorStore((s) => s.sessions[sessionId]?.running ?? false);
    const setSample = useMonitorStore((s) => s.setSample);
    const setError = useMonitorStore((s) => s.setError);
    const setRunning = useMonitorStore((s) => s.setRunning);
    const setMonitorPanelVisible = useUIStore((s) => s.setMonitorPanelVisible);

    // 事件监听：只处理当前会话的帧，切换标签后旧会话的数据不会串到新面板
    useEffect(() => {
        const offSample = Events.On(MONITOR_SAMPLE_EVENT, (event) => {
            const data = event?.data as MonitorSample | null;
            if (!data || data.sessionId !== sessionId) return;
            setSample(data);

            // 告警判定：阈值 → 连续计数 → 冷却。设置值实时从 store 读取，
            // 用户在设置页调整阈值后无需重新打开面板。
            const ui = useUIStore.getState();
            if (!ui.monitorAlertsEnabled) {
                setActiveAlerts((prev) => (prev.length === 0 ? prev : []));
                resetAlertTrackers(sessionId);
                return;
            }
            const thresholds = {
                cpu: ui.monitorCpuThreshold,
                memory: ui.monitorMemoryThreshold,
                disk: ui.monitorDiskThreshold,
            };
            const breaches = detectBreaches(data, thresholds);
            const nextMetrics = breaches.map((item) => item.metric);
            setActiveAlerts((prev) => (sameAlertMetrics(prev, nextMetrics) ? prev : nextMetrics));

            const triggered = registerAlertBreaches(sessionId, breaches, ui.monitorAlertStreak);
            if (triggered.length === 0) return;
            const sessionInfo = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
            const hostLabel = sessionInfo?.title || sessionInfo?.config.host || sessionId;
            for (const item of triggered) {
                const metricLabel = t(`monitor_alert_metric_${item.metric}`);
                toast.warning(t("monitor_alert_toast", {
                    metric: metricLabel,
                    value: item.value.toFixed(1),
                    threshold: item.threshold,
                }));
                // 桌面通知只在窗口隐藏时发送：用户正在看面板时应用内提示已足够
                if (ui.monitorDesktopNotify && document.visibilityState === "hidden") {
                    showDesktopNotification(
                        t("monitor_alert_notify_title", { host: hostLabel }),
                        t("monitor_alert_notify_body", {
                            metric: metricLabel,
                            value: item.value.toFixed(1),
                            threshold: item.threshold,
                            detail: item.detail ? t("monitor_alert_detail", { detail: item.detail }) : "",
                        }),
                    );
                }
            }
        });
        const offError = Events.On(MONITOR_ERROR_EVENT, (event) => {
            const data = event?.data as {sessionId?: string; message?: string} | null;
            if (!data || data.sessionId !== sessionId) return;
            setError(sessionId, data.message || t("monitor_error_unknown"));
        });
        return () => {
            offSample();
            offError();
        };
    }, [sessionId, setSample, setError, t]);

    // 启停采集：仅在会话已连接时启动；断开时立即停止并保留最后一帧。
    // 切换刷新间隔不在此处发 Stop：后端 Start 自身会先停旧循环再按新间隔重建，
    // 少一次 IPC 也就少一处 Stop/Start 乱序的机会。
    useEffect(() => {
        if (!isSshKind(session?.kind) || session?.status !== "connected") {
            setRunning(sessionId, false);
            enqueueMonitorCommand(() => MonitorService.Stop(sessionId));
            return;
        }
        setRunning(sessionId, true, intervalMS);
        let active = true;
        enqueueMonitorCommand(async () => {
            try {
                await MonitorService.Start(sessionId, intervalMS);
            } catch (err) {
                if (active) setError(sessionId, String((err as Error)?.message ?? err));
            }
        });
        return () => {
            active = false;
        };
    }, [sessionId, session?.kind, session?.status, intervalMS, retryNonce, setRunning, setError]);

    // 切换会话或关闭面板：停止该会话的采集并清理历史，避免重新打开看到过期曲线
    useEffect(() => {
        return () => {
            enqueueMonitorCommand(() => MonitorService.Stop(sessionId));
            useMonitorStore.getState().resetSession(sessionId);
            resetAlertTrackers(sessionId);
        };
    }, [sessionId]);

    const handleIntervalChange = (value: string) => {
        const next = Number(value);
        if (!INTERVAL_OPTIONS.includes(next as (typeof INTERVAL_OPTIONS)[number])) return;
        setIntervalMS(next);
        try {
            localStorage.setItem(INTERVAL_STORAGE_KEY, String(next));
        } catch {
            // localStorage 不可用时仅影响下次启动的默认值
        }
    };

    const handleRangeChange = (minutes: number) => {
        setRangeMinutes(minutes);
        try {
            localStorage.setItem(RANGE_STORAGE_KEY, String(minutes));
        } catch {
            // 同上，仅影响下次启动的默认值
        }
    };

    // 时间范围只在渲染层裁剪：保留完整历史，切换范围时无需重新采样
    const rangedHistory = useMemo(
        () => selectRange(history, rangeMinutes),
        [history, rangeMinutes]
    );

    const isPaused = !isSshKind(session?.kind) || session?.status !== "connected";

    /** 导出当前时间范围内的趋势数据为 CSV */
    const handleExportHistory = async () => {
        if (exporting) return;
        if (rangedHistory.length === 0) {
            toast.info(t("monitor_export_empty"));
            return;
        }
        setExporting(true);
        try {
            const host = safeFilePart(session?.title || session?.config.host || "", "server");
            const path = await Dialogs.SaveFile({
                Title: t("monitor_export_history"),
                Filename: `monitor-${host}-${fileStamp(new Date())}.csv`,
            });
            if (!path) return; // 用户取消保存
            await TextFileService.SaveText(path, historyToCsv(rangedHistory));
            toast.success(t("monitor_export_success"));
        } catch (err) {
            // 关闭保存对话框时 wails 会抛出 "cancelled by user"，不是错误
            if (!/cancel/i.test(String((err as Error)?.message ?? err))) {
                toast.error(t("monitor_export_failed"), {description: parseAppError(err).message});
            }
        } finally {
            setExporting(false);
        }
    };

    /** 发送终止信号：TERM 优雅退出，KILL 强制终止 */
    const handleKillProcess = async (signal: "TERM" | "KILL") => {
        const target = killTarget;
        if (!target || killBusy) return;
        setKillBusy(true);
        try {
            await MonitorService.KillProcess(sessionId, target.pid, signal);
            toast.success(t("monitor_kill_success", {pid: target.pid, signal}));
            setKillTarget(null);
        } catch (err) {
            toast.error(t("monitor_kill_failed"), {description: parseAppError(err).message});
        } finally {
            setKillBusy(false);
        }
    };

    return (
        <div className="monitor-panel" data-monitor-panel>
            {/* 头部：标题 + 采集状态 + 间隔 + 关闭 */}
            <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2">
                <Gauge className="size-4 shrink-0 text-[var(--fg-muted)]"/>
                <span className="text-[12.5px] text-[var(--fg-strong)]">{t("monitor_title")}</span>
                <span
                    className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        running ? "animate-pulse bg-[var(--success)]" : "bg-[var(--fg-subtle)]"
                    )}
                    title={running ? t("monitor_live") : t("monitor_paused")}
                />
                {activeAlerts.length > 0 && (
                    <span
                        className="flex items-center text-[var(--destructive)]"
                        title={t("monitor_alert_active", {
                            metrics: activeAlerts.map((metric) => t(`monitor_alert_metric_${metric}`)).join(" / "),
                        })}
                    >
                        <TriangleAlert className="size-3.5 animate-pulse"/>
                    </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                    {/* 趋势时间范围：只影响折线窗口，切换时不重启采集 */}
                    <div
                        className="flex items-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-2)] p-px"
                        role="group"
                        aria-label={t("monitor_range_label")}
                        title={t("monitor_range_tip", {minutes: rangeMinutes})}
                    >
                        {RANGE_OPTIONS.map((minutes) => (
                            <button
                                key={minutes}
                                type="button"
                                onClick={() => handleRangeChange(minutes)}
                                className={cn(
                                    "rounded-[3px] px-1.5 py-0.5 text-[10px] tabular-nums transition-colors",
                                    rangeMinutes === minutes
                                        ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                        : "text-[var(--fg-subtle)] hover:text-[var(--fg-strong)]"
                                )}
                            >
                                {t("monitor_range_value", {minutes})}
                            </button>
                        ))}
                    </div>
                    <Select value={String(intervalMS)} onValueChange={handleIntervalChange}>
                        <SelectTrigger
                            className="h-6 w-[74px] border-[var(--hairline)] bg-[var(--surface-2)] px-1.5 text-[10.5px]"
                            aria-label={t("monitor_interval")}
                            title={t("monitor_interval")}
                        >
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            {INTERVAL_OPTIONS.map((value) => (
                                <SelectItem key={value} value={String(value)}>
                                    {t("monitor_interval_value", {seconds: value / 1000})}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <button
                        type="button"
                        onClick={handleExportHistory}
                        disabled={exporting || rangedHistory.length === 0}
                        className="flex size-6 items-center justify-center rounded-[var(--radius-sm)]
                                   text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]
                                   disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent
                                   disabled:hover:text-[var(--fg-muted)]"
                        title={t("monitor_export_history")}
                        aria-label={t("monitor_export_history")}
                    >
                        <Download className="size-3.5"/>
                    </button>
                    <button
                        type="button"
                        onClick={() => setMonitorPanelVisible(false)}
                        className="flex size-6 items-center justify-center rounded-[var(--radius-sm)]
                                   text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg-strong)]"
                        title={t("monitor_close")}
                        aria-label={t("monitor_close")}
                    >
                        <X className="size-3.5"/>
                    </button>
                </div>
            </div>

            <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
                {error ? (
                    <StateCard
                        icon={TriangleAlert}
                        tone="danger"
                        title={t("monitor_error")}
                        description={error}
                        action={(
                            <button
                                type="button"
                                onClick={() => setRetryNonce((n) => n + 1)}
                                className="terminal-overlay-btn px-2.5 py-1 text-[11px]"
                            >
                                <RotateCw className="size-3"/>
                                {t("monitor_retry")}
                            </button>
                        )}
                    />
                ) : !sample ? (
                    <StateCard
                        icon={Activity}
                        title={t("monitor_loading")}
                        description={isPaused ? t("monitor_paused") : t("monitor_loading_hint")}
                    />
                ) : !sample.supported ? (
                    <StateCard
                        icon={Info}
                        title={t("monitor_unsupported")}
                        description={t("monitor_unsupported_hint")}
                    />
                ) : (
                    <>
                        {isPaused && (
                            <div className="rounded-[var(--radius-md)] border border-[var(--warning)]/30
                                            bg-[var(--warning)]/10 px-2.5 py-1.5 text-[11px] text-[var(--warning)]">
                                {t("monitor_paused")}
                            </div>
                        )}
                        <CpuCard sample={sample} history={rangedHistory} alert={activeAlerts.includes("cpu")}/>
                        <MemoryCard sample={sample} history={rangedHistory} alert={activeAlerts.includes("memory")}/>
                        {sample.gpu?.length > 0 && <GpuCard gpu={sample.gpu}/>}
                        <NetworkCard sample={sample} history={rangedHistory}/>
                        <DiskCard sample={sample} history={rangedHistory} alert={activeAlerts.includes("disk")}/>
                        <ProcessCard sample={sample} onKill={setKillTarget}/>
                        <SystemCard sample={sample}/>
                    </>
                )}
            </div>

            {/* 终止进程确认：TERM 与 KILL 两个入口，避免误操作强杀 */}
            <AlertDialog
                open={killTarget !== null}
                onOpenChange={(open) => {
                    if (!open && !killBusy) setKillTarget(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {t("monitor_kill_confirm_title", {pid: killTarget?.pid ?? 0})}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("monitor_kill_confirm_desc", {
                                user: killTarget?.user || "—",
                                command: killTarget?.command || "—",
                            })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel
                            disabled={killBusy}
                            onClick={() => setKillTarget(null)}
                        >
                            {t("monitor_kill_cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            variant="outline"
                            disabled={killBusy}
                            className="border-[var(--destructive)]/40 text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                            onClick={(event) => {
                                event.preventDefault();
                                void handleKillProcess("KILL");
                            }}
                        >
                            {t("monitor_kill_force")}
                        </AlertDialogAction>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={killBusy}
                            onClick={(event) => {
                                event.preventDefault();
                                void handleKillProcess("TERM");
                            }}
                        >
                            {t("monitor_kill_term")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

// ─── 指标卡片 ──────────────────────────────────────────

interface MetricCardProps {
    icon: ComponentType<{ className?: string }>;
    title: string;
    aside?: ReactNode;
    /** 指标当前超过告警阈值：边框与标题使用警示色 */
    alert?: boolean;
    children: ReactNode;
}

function MetricCard({icon: Icon, title, aside, alert, children}: MetricCardProps) {
    return (
        <section
            className={cn(
                "rounded-[var(--radius-md)] border p-2.5",
                alert
                    ? "border-[var(--destructive)]/50 bg-[var(--destructive)]/5"
                    : "border-[var(--hairline)] bg-[var(--surface-2)]"
            )}
        >
            <header
                className={cn(
                    "mb-2 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em]",
                    alert ? "text-[var(--destructive)]" : "text-[var(--fg-subtle)]"
                )}
            >
                <Icon className="size-3 shrink-0"/>
                <span className="flex-1">{title}</span>
                {alert && <TriangleAlert className="size-3 shrink-0"/>}
                {aside}
            </header>
            {children}
        </section>
    );
}

interface StateCardProps {
    icon: ComponentType<{ className?: string }>;
    title: string;
    description: string;
    tone?: "default" | "danger";
    action?: ReactNode;
}

function StateCard({icon: Icon, title, description, tone, action}: StateCardProps) {
    return (
        <div className="rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--surface-2)] p-3">
            <div className={cn("flex items-center gap-2 text-xs", tone === "danger" ? "text-[var(--destructive)]" : "text-[var(--fg-muted)]")}>
                <Icon className="size-3.5 shrink-0"/>
                <span className="font-medium">{title}</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--fg-subtle)]">{description}</p>
            {action && <div className="mt-2">{action}</div>}
        </div>
    );
}

/** 大号数值 + 小单位，避免百分比与数值基线错位 */
function BigValue({value, suffix}: {value: string; suffix: string}) {
    return (
        <span className="font-mono text-[22px] font-medium leading-none tabular-nums text-[var(--fg-strong)]">
            {value}
            <span className="ml-0.5 text-[11px] font-normal text-[var(--fg-muted)]">{suffix}</span>
        </span>
    );
}

/** 迷你折线：values 会按 max 归一化，用于 CPU/内存趋势 */
function Sparkline({values, max = 100, className, dashed}: {
    values: number[];
    max?: number;
    className?: string;
    dashed?: boolean;
}) {
    if (values.length < 2) return <div className={cn("h-8", className)}/>;
    const top = Math.max(max, ...values, 1);
    const points = values
        .map((value, index) => {
            const x = (index / (values.length - 1)) * 100;
            const y = 27 - Math.min(1, Math.max(0, value / top)) * 26;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    return (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn("h-8 w-full", className)} aria-hidden>
            <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={dashed ? "3 2" : undefined}
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/** 双序列折线（网络上下行 / 磁盘读写），共享同一个归一化上限 */
function DualSparkline({first, second, className}: {first: number[]; second: number[]; className?: string}) {
    const length = Math.max(first.length, second.length);
    if (length < 2) return <div className={cn("h-8", className)}/>;
    const top = Math.max(1, ...first, ...second);
    const build = (values: number[]) => values
        .map((value, index) => {
            const x = length > 1 ? (index / (length - 1)) * 100 : 0;
            const y = 27 - Math.min(1, Math.max(0, value / top)) * 26;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    return (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn("h-8 w-full", className)} aria-hidden>
            <polyline
                points={build(first)}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
            />
            <polyline
                points={build(second)}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.55"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/** 百分比条：达到 70%/90% 时切换警示色 */
function UsageBar({percent, className}: {percent: number; className?: string}) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <div className={cn("h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]", className)}>
            <div
                className={cn(
                    "h-full rounded-full transition-[width] duration-[var(--motion-base)]",
                    clamped >= 90 ? "bg-[var(--destructive)]" : clamped >= 70 ? "bg-[var(--warning)]" : "bg-[var(--primary)]"
                )}
                style={{width: `${clamped}%`}}
            />
        </div>
    );
}

/** 速率格式化：字节/秒 → 人类可读 */
function formatRate(bps: number): string {
    if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
    return `${formatFileSize(Math.round(bps))}/s`;
}

/** TCP 状态缩写：面板宽度有限，ESTABLISHED 这类长名称会挤爆一行 */
const TCP_SHORT_NAMES: Record<string, string> = {
    ESTABLISHED: "EST",
    LISTEN: "LSN",
    TIME_WAIT: "TW",
    CLOSE_WAIT: "CW",
    SYN_SENT: "SYN",
    SYN_RECV: "SYN_R",
    FIN_WAIT1: "FW1",
    FIN_WAIT2: "FW2",
    LAST_ACK: "LACK",
    CLOSING: "CLG",
    CLOSE: "CLS",
    NEW_SYN_RECV: "NSR",
};

function tcpShortName(state: string): string {
    return TCP_SHORT_NAMES[state] ?? state.replace(/_/g, "").slice(0, 5);
}

function formatUptime(seconds: number, t: TFunction): string {
    if (seconds <= 0) return "—";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return t("uptime_days", {days, hours});
    if (hours > 0) return t("uptime_hours", {hours, minutes});
    return t("uptime_minutes", {minutes});
}

// ─── 各指标卡片 ──────────────────────────────────────────

function CpuCard({sample, history, alert}: {sample: MonitorSample; history: {cpu: number}[]; alert?: boolean}) {
    const {t} = useTranslation("terminal");
    const cpu = sample.cpu;
    const perCore = cpu?.perCore ?? [];
    const values = useMemo(() => history.map((point) => point.cpu), [history]);
    return (
        <MetricCard
            icon={Cpu}
            title={t("monitor_cpu")}
            alert={alert}
            aside={(
                <span className="text-[10px] normal-case tracking-normal text-[var(--fg-subtle)]">
                    {sample.system?.cpuCount ? t("monitor_cores", {count: sample.system.cpuCount}) : ""}
                </span>
            )}
        >
            <div className="flex items-baseline justify-between gap-2">
                <BigValue value={(cpu?.usage ?? 0).toFixed(1)} suffix="%"/>
                <div className="text-right text-[10px] leading-tight text-[var(--fg-subtle)]">
                    <div className="font-mono tabular-nums">{t("monitor_load")} {(cpu?.load1 ?? 0).toFixed(2)}</div>
                    <div className="font-mono tabular-nums text-[var(--fg-muted)]">
                        {(cpu?.load5 ?? 0).toFixed(2)} / {(cpu?.load15 ?? 0).toFixed(2)}
                    </div>
                </div>
            </div>
            <Sparkline values={values} max={100} className="mt-1 text-[var(--primary)]"/>
            {perCore.length > 0 && (
                <div className="mt-1 flex h-5 items-end gap-px" title={t("monitor_per_core")}>
                    {perCore.slice(0, 64).map((value, index) => (
                        <div
                            key={index}
                            className="min-w-px flex-1 rounded-t-[1px] bg-[var(--primary)]/65"
                            style={{height: `${Math.max(2, Math.min(100, value))}%`}}
                        />
                    ))}
                </div>
            )}
            <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10.5px] text-[var(--fg-subtle)]">
                <span>{t("monitor_cpu_user")} <Value>{cpu?.user.toFixed(1)}%</Value></span>
                <span>{t("monitor_cpu_system")} <Value>{cpu?.system.toFixed(1)}%</Value></span>
                <span>{t("monitor_cpu_iowait")} <Value>{cpu?.iowait.toFixed(1)}%</Value></span>
            </div>
        </MetricCard>
    );
}

function Value({children}: {children: React.ReactNode}) {
    return <span className="font-mono tabular-nums text-[var(--fg-strong)]">{children}</span>;
}

function MemoryCard({sample, history, alert}: {sample: MonitorSample; history: {mem: number}[]; alert?: boolean}) {
    const {t} = useTranslation("terminal");
    const memory = sample.memory;
    const percent = memory?.total > 0 ? (memory.used / memory.total) * 100 : 0;
    const values = useMemo(() => history.map((point) => point.mem), [history]);
    return (
        <MetricCard icon={MemoryStick} title={t("monitor_memory")} alert={alert}>
            <div className="flex items-baseline justify-between gap-2">
                <BigValue value={percent.toFixed(1)} suffix="%"/>
                <span className="font-mono text-[10.5px] tabular-nums text-[var(--fg-muted)]">
                    {formatFileSize(memory?.used ?? 0)} / {formatFileSize(memory?.total ?? 0)}
                </span>
            </div>
            <Sparkline values={values} max={100} className="mt-1 text-[var(--success)]"/>
            <UsageBar percent={percent} className="mt-1"/>
            <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px] text-[var(--fg-subtle)]">
                <span>{t("monitor_free")} <Value>{formatFileSize(memory?.free ?? 0)}</Value></span>
                <span>{t("monitor_buffers")} <Value>{formatFileSize(memory?.buffers ?? 0)}</Value></span>
                <span>{t("monitor_cached")} <Value>{formatFileSize(memory?.cached ?? 0)}</Value></span>
            </div>
            {memory?.swapTotal > 0 && (
                <div className="mt-2">
                    <div className="flex items-center justify-between text-[10px] text-[var(--fg-subtle)]">
                        <span>{t("monitor_swap")}</span>
                        <span className="font-mono tabular-nums">
                            {formatFileSize(memory.swapUsed)} / {formatFileSize(memory.swapTotal)}
                        </span>
                    </div>
                    <UsageBar percent={memory.swapTotal > 0 ? (memory.swapUsed / memory.swapTotal) * 100 : 0} className="mt-1"/>
                </div>
            )}
        </MetricCard>
    );
}

function NetworkCard({sample, history}: {sample: MonitorSample; history: {rxBps: number; txBps: number}[]}) {
    const {t} = useTranslation("terminal");
    const network = sample.network ?? [];
    const tcpStates = sample.tcpStates ?? [];
    const rx = useMemo(() => history.map((point) => point.rxBps), [history]);
    const tx = useMemo(() => history.map((point) => point.txBps), [history]);
    const rxTotal = network.reduce((sum, item) => sum + item.rxBps, 0);
    const txTotal = network.reduce((sum, item) => sum + item.txBps, 0);
    const rxPps = network.reduce((sum, item) => sum + (item.rxPps ?? 0), 0);
    const txPps = network.reduce((sum, item) => sum + (item.txPps ?? 0), 0);
    const drops = network.reduce((sum, item) => sum + (item.rxDrops ?? 0) + (item.txDrops ?? 0), 0);
    const connections = tcpStates.reduce((sum, item) => sum + item.count, 0);

    return (
        <MetricCard
            icon={Network}
            title={t("monitor_network")}
            aside={(
                <span className="font-mono text-[10px] normal-case tracking-normal tabular-nums">
                    <span className="text-[var(--primary)]">↓{formatRate(rxTotal)}</span>
                    {" "}
                    <span className="text-[var(--warning)]">↑{formatRate(txTotal)}</span>
                </span>
            )}
        >
            <DualSparkline first={rx} second={tx} className="text-[var(--primary)]"/>
            {network.length === 0 ? (
                <p className="text-[10.5px] text-[var(--fg-subtle)]">{t("monitor_no_network")}</p>
            ) : (
                <ul className="mt-1 space-y-1">
                    {network.slice(0, 4).map((item) => (
                        <li
                            key={item.name}
                            className="flex items-center gap-2 text-[10.5px]"
                            title={t("monitor_network_detail", {
                                name: item.name,
                                pps: Math.round(item.rxPps ?? 0) + Math.round(item.txPps ?? 0),
                                drops: (item.rxDrops ?? 0) + (item.txDrops ?? 0),
                                errors: item.rxErrors + item.txErrors,
                            })}
                        >
                            <span className="w-16 shrink-0 truncate font-mono text-[var(--fg-muted)]" title={item.name}>
                                {item.name}
                            </span>
                            <span className="text-[var(--primary)]">↓ {formatRate(item.rxBps)}</span>
                            <span className="ml-auto text-[var(--warning)]">↑ {formatRate(item.txBps)}</span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 border-t border-[var(--hairline)] pt-1.5 text-[10px] text-[var(--fg-subtle)]">
                <span>
                    {t("monitor_pps")}{" "}
                    <Value>↓{Math.round(rxPps)} ↑{Math.round(txPps)}</Value>
                </span>
                <span>
                    {t("monitor_drops")} <Value>{drops}</Value>
                </span>
                <span>
                    {t("monitor_tcp_conns")} <Value>{connections}</Value>
                </span>
            </div>
            {tcpStates.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                    {tcpStates.slice(0, 5).map((item) => (
                        <span
                            key={item.state}
                            title={`${item.state} ${item.count}`}
                            className="rounded bg-[var(--surface-3)] px-1 py-0.5 font-mono text-[9.5px] text-[var(--fg-muted)]"
                        >
                            {tcpShortName(item.state)} {item.count}
                        </span>
                    ))}
                </div>
            )}
        </MetricCard>
    );
}

function DiskCard({sample, history, alert}: {sample: MonitorSample; history: {readBps: number; writeBps: number}[]; alert?: boolean}) {
    const {t} = useTranslation("terminal");
    const disk = sample.disk ?? [];
    const filesystems = sample.filesystems ?? [];
    const read = useMemo(() => history.map((point) => point.readBps), [history]);
    const write = useMemo(() => history.map((point) => point.writeBps), [history]);

    return (
        <MetricCard icon={HardDrive} title={t("monitor_disk")} alert={alert}>
            <DualSparkline first={read} second={write} className="text-[var(--success)]"/>
            {disk.length === 0 ? (
                <p className="text-[10.5px] text-[var(--fg-subtle)]">{t("monitor_no_disk")}</p>
            ) : (
                <ul className="mt-1 space-y-1">
                    {disk.slice(0, 4).map((item) => (
                        <li key={item.name} className="flex items-center gap-2 text-[10.5px]">
                            <span className="w-14 shrink-0 truncate font-mono text-[var(--fg-muted)]" title={item.name}>
                                {item.name}
                            </span>
                            <span className="text-[var(--fg-strong)]">R {formatRate(item.readBps)}</span>
                            <span className="ml-auto text-[var(--fg-muted)]">W {formatRate(item.writeBps)}</span>
                            <span className="w-14 text-right font-mono tabular-nums text-[var(--fg-subtle)]">
                                {t("monitor_iops_value", {value: item.iops.toFixed(0)})}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {filesystems.length > 0 && (
                <div className="mt-1.5 space-y-1.5 border-t border-[var(--hairline)] pt-1.5">
                    <div className="text-[9.5px] uppercase tracking-wide text-[var(--fg-subtle)]">
                        {t("monitor_disk_capacity")}
                    </div>
                    {filesystems.slice(0, 3).map((item) => (
                        <div key={`${item.device}-${item.mount}`} title={`${item.device} → ${item.mount}`}>
                            <div className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="min-w-0 truncate font-mono text-[var(--fg-muted)]">
                                    {item.mount}
                                </span>
                                <span className="shrink-0 font-mono tabular-nums text-[var(--fg-subtle)]">
                                    {formatFileSize(item.used)} / {formatFileSize(item.total)}
                                </span>
                            </div>
                            <UsageBar percent={item.usagePercent} className="mt-0.5"/>
                        </div>
                    ))}
                </div>
            )}
        </MetricCard>
    );
}

/** GPU 卡片：仅在 nvidia-smi 返回数据时展示，无 GPU 的服务器不占版面 */
function GpuCard({gpu}: {gpu: GPUStat[]}) {
    const {t} = useTranslation("terminal");
    return (
        <MetricCard
            icon={Gpu}
            title={t("monitor_gpu")}
            aside={(
                <span className="text-[10px] normal-case tracking-normal text-[var(--fg-subtle)]">
                    {t("monitor_gpu_count", {count: gpu.length})}
                </span>
            )}
        >
            <div className="space-y-2">
                {gpu.map((item) => {
                    const memPercent = item.memoryTotal > 0 ? (item.memoryUsed / item.memoryTotal) * 100 : 0;
                    return (
                        <div key={`${item.index}-${item.name}`}>
                            <div className="flex items-center justify-between gap-2 text-[10.5px]">
                                <span
                                    className="min-w-0 truncate font-mono text-[var(--fg-muted)]"
                                    title={item.name}
                                >
                                    {item.name}
                                </span>
                                <span className="shrink-0 font-mono tabular-nums text-[var(--fg-strong)]">
                                    {item.utilization.toFixed(0)}%
                                </span>
                            </div>
                            <UsageBar percent={item.utilization} className="mt-1"/>
                            <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--fg-subtle)]">
                                <span>
                                    {t("monitor_gpu_memory")} <Value>{formatFileSize(item.memoryUsed)} / {formatFileSize(item.memoryTotal)}</Value>
                                </span>
                                {item.temperature > 0 && (
                                    <span>
                                        {t("monitor_gpu_temp")} <Value>{item.temperature.toFixed(0)}°C</Value>
                                    </span>
                                )}
                            </div>
                            {item.memoryTotal > 0 && <UsageBar percent={memPercent} className="mt-1"/>}
                        </div>
                    );
                })}
            </div>
        </MetricCard>
    );
}

function ProcessCard({sample, onKill}: {sample: MonitorSample; onKill: (process: ProcessStat) => void}) {
    const {t} = useTranslation("terminal");
    const processes = sample.processes ?? [];
    const [sortBy, setSortBy] = useState<"cpu" | "mem">("cpu");

    const sorted = useMemo(() => {
        const list = [...processes];
        list.sort((a, b) => sortBy === "cpu" ? b.cpu - a.cpu : b.mem - a.mem);
        return list.slice(0, 6);
    }, [processes, sortBy]);

    return (
        <MetricCard
            icon={ListTree}
            title={t("monitor_processes")}
            aside={(
                <span className="flex items-center gap-1 normal-case tracking-normal">
                    <button
                        type="button"
                        onClick={() => setSortBy("cpu")}
                        className={cn(
                            "rounded px-1 py-0.5 text-[9.5px] transition-colors",
                            sortBy === "cpu"
                                ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                : "text-[var(--fg-subtle)] hover:text-[var(--fg-strong)]"
                        )}
                    >
                        {t("monitor_sort_cpu")}
                    </button>
                    <button
                        type="button"
                        onClick={() => setSortBy("mem")}
                        className={cn(
                            "rounded px-1 py-0.5 text-[9.5px] transition-colors",
                            sortBy === "mem"
                                ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                : "text-[var(--fg-subtle)] hover:text-[var(--fg-strong)]"
                        )}
                    >
                        {t("monitor_sort_mem")}
                    </button>
                </span>
            )}
        >
            {processes.length === 0 ? (
                <p className="text-[10.5px] text-[var(--fg-subtle)]">{t("monitor_no_process")}</p>
            ) : (
                <div className="space-y-1">
                    <div className="grid grid-cols-[32px_42px_42px_1fr_16px] gap-1.5 text-[9.5px] uppercase tracking-wide text-[var(--fg-subtle)]">
                        <span>PID</span>
                        <span className="text-right">CPU</span>
                        <span className="text-right">MEM</span>
                        <span>COMMAND</span>
                        <span/>
                    </div>
                    {sorted.map((item) => (
                        <div
                            key={`${item.pid}-${item.command}`}
                            className="group grid grid-cols-[32px_42px_42px_1fr_16px] items-center gap-1.5 text-[10.5px]"
                            title={`${item.user} · ${t("monitor_rss", {value: formatFileSize(item.rss)})} · ${item.time}`}
                        >
                            <span className="font-mono tabular-nums text-[var(--fg-subtle)]">{item.pid}</span>
                            <span className="text-right font-mono tabular-nums text-[var(--fg-strong)]">
                                {item.cpu.toFixed(1)}
                            </span>
                            <span className="text-right font-mono tabular-nums text-[var(--fg-muted)]">
                                {item.mem.toFixed(1)}
                            </span>
                            <span className="min-w-0 truncate font-mono text-[var(--fg-muted)]" title={item.command}>
                                {item.command || "—"}
                            </span>
                            <button
                                type="button"
                                onClick={() => onKill(item)}
                                className="flex size-4 items-center justify-center rounded text-[var(--fg-subtle)]
                                           opacity-0 transition-[opacity,background-color,color] hover:bg-[var(--destructive)]/15
                                           hover:text-[var(--destructive)] focus-visible:opacity-100 group-hover:opacity-100"
                                title={t("monitor_kill_process")}
                                aria-label={t("monitor_kill_process")}
                            >
                                <Skull className="size-3"/>
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </MetricCard>
    );
}

function SystemCard({sample}: {sample: MonitorSample}) {
    const {t} = useTranslation("terminal");
    const system = sample.system;
    const rows: {label: string; value: string}[] = [
        {label: t("monitor_hostname"), value: system?.hostname || "—"},
        {label: t("monitor_os"), value: system?.os || "—"},
        {label: t("monitor_kernel"), value: system?.kernel || "—"},
        {label: t("monitor_uptime"), value: formatUptime(system?.uptime ?? 0, t)},
        {label: t("monitor_users"), value: String(system?.users ?? 0)},
        {label: t("monitor_last_update"), value: new Date(sample.timestamp).toLocaleTimeString()},
    ];
    return (
        <MetricCard icon={Info} title={t("monitor_system")}>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10.5px]">
                {rows.map((row) => (
                    <InfoRow key={row.label} label={row.label} value={row.value}/>
                ))}
            </div>
        </MetricCard>
    );
}

/** 系统信息行：标签左、值右对齐并允许截断 */
function InfoRow({label, value}: {label: string; value: string}) {
    return (
        <>
            <span className="text-[var(--fg-subtle)]">{label}</span>
            <span className="min-w-0 truncate text-right font-mono text-[var(--fg-strong)]" title={value}>
                {value}
            </span>
        </>
    );
}
