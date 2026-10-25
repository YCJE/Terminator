// 日志查看器组件：显示应用日志，支持刷新、复制、清除、鼠标选中复制
// 美化日志格式：[2026-07-06 02:21:29 UTC+8] [INFO] 消息内容
// 按级别着色：INFO=蓝色, ERROR=红色, WARN=黄色, DEBUG=灰色
// 提供两个页签：应用日志（运行日志）与会话日志（终端输出落盘后的检索与预览）
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollText, RefreshCw, Copy, Trash2, Check, Search, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsService } from "../../../bindings/terminator-desktop/backend/internal/services/settings";
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import type {
    SessionLogFile,
    SessionLogMatch,
} from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { handleAppError } from "@/lib/error";
import { formatFileSize, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 解析单条日志，提取时间、级别、消息 */
interface ParsedLogLine {
    time: string;
    level: string;
    message: string;
    raw: string;
}

function parseLogLine(line: string): ParsedLogLine {
    // 原始格式: time=2026-07-06T02:21:29.253+08:00 level=INFO msg="..."
    const timeMatch = line.match(/^time=(\S+)\s/);
    const levelMatch = line.match(/level=(\w+)\s/);
    const msgMatch = line.match(/msg="((?:[^"\\]|\\.)*)"/);

    if (!timeMatch || !levelMatch) {
        return { time: "", level: "", message: line, raw: line };
    }

    // 格式化时间: 2026-07-06T02:21:29.253+08:00 → 2026-07-06 02:21:29 UTC+8
    const rawTime = timeMatch[1];
    let formattedTime = rawTime;
    const timeParse = rawTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d+)([+-]\d{2}):?(\d{2})$/);
    if (timeParse) {
        const tzSign = timeParse[4];
        const tzHour = timeParse[4].replace("+", "").replace("-", "");
        const tzStr = `UTC${tzSign.startsWith("-") ? "-" : "+"}${parseInt(tzHour)}`;
        formattedTime = `${timeParse[1]} ${timeParse[2]} ${tzStr}`;
    }

    const level = levelMatch[1];
    let message = msgMatch ? msgMatch[1] : "";

    // 提取 msg 之后的多余字段 (url=, file= 等)
    const msgEndIndex = line.indexOf('msg="');
    if (msgEndIndex >= 0) {
        // 找到 msg="..." 的结束引号
        let i = msgEndIndex + 5; // skip 'msg="'
        while (i < line.length && line[i] !== '"') {
            if (line[i] === "\\") i++; // 跳过转义字符
            i++;
        }
        const afterMsg = line.substring(i + 1).trim();
        if (afterMsg) {
            message = message + " " + afterMsg;
        }
    }

    return { time: formattedTime, level, message, raw: line };
}

/** 日志级别对应的颜色样式 */
function getLevelColor(level: string): string {
    switch (level.toUpperCase()) {
        case "ERROR":
            return "text-destructive";
        case "WARN":
        case "WARNING":
            return "text-warning";
        case "INFO":
            return "text-info";
        case "DEBUG":
            return "text-[var(--fg-subtle)]";
        default:
            return "text-[var(--fg-muted)]";
    }
}

function getLevelBgColor(level: string): string {
    switch (level.toUpperCase()) {
        case "ERROR":
            return "bg-destructive/10";
        case "WARN":
        case "WARNING":
            return "bg-warning/10";
        case "INFO":
            return "bg-info/5";
        default:
            return "";
    }
}

/** 预览上限：避免超大日志文件一次性渲染阻塞界面 */
const PREVIEW_CHAR_LIMIT = 200_000;

type LogTab = "app" | "session";

export function LogViewer() {
    const { t } = useTranslation("settings");
    const [tab, setTab] = useState<LogTab>("app");

    // ─── 应用日志 ─────────────────────────────────────────────
    const [rawLogs, setRawLogs] = useState("");
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ─── 会话日志 ─────────────────────────────────────────────
    const [logFiles, setLogFiles] = useState<SessionLogFile[]>([]);
    const [logLoading, setLogLoading] = useState(false);
    const [selectedLog, setSelectedLog] = useState<string | null>(null);
    const [logContent, setLogContent] = useState("");
    const [logQuery, setLogQuery] = useState("");
    const [matches, setMatches] = useState<SessionLogMatch[] | null>(null);
    const [searching, setSearching] = useState(false);
    // 请求序号：预览与检索共用同一把"最新请求"闸门。
    // 快速连续点击不同文件、或在检索未返回时再次检索时，慢请求的响应可能
    // 晚于新请求返回，把界面回填成旧文件的内容/旧关键字的结果。
    const previewSeqRef = useRef(0);
    const searchSeqRef = useRef(0);

    // 卸载时清理定时器
    useEffect(() => {
        return () => {
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        };
    }, []);

    const loadLogs = useCallback(async () => {
        setLoading(true);
        try {
            const content = await SettingsService.GetLogs(500);
            setRawLogs(content || "");
        } catch (err) {
            handleAppError(err);
            setRawLogs("");
        } finally {
            setLoading(false);
        }
    }, []);

    const handleCopy = useCallback(async () => {
        if (!rawLogs) return;
        const doCopy = () => {
            setCopied(true);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
        };
        try {
            await navigator.clipboard.writeText(rawLogs);
            doCopy();
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = rawLogs;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            doCopy();
        }
    }, [rawLogs]);

    const handleClear = useCallback(async () => {
        try {
            await SettingsService.ClearLogs();
            setRawLogs("");
        } catch (err) {
            handleAppError(err);
        }
    }, []);

    // 加载会话日志文件列表（按修改时间倒序，由后端排序）
    const loadSessionLogs = useCallback(async () => {
        setLogLoading(true);
        try {
            const files = await SshService.ListSessionLogs();
            setLogFiles(files || []);
        } catch (err) {
            handleAppError(err);
            setLogFiles([]);
        } finally {
            setLogLoading(false);
        }
    }, []);

    // 首次切到会话日志页签时自动加载列表
    useEffect(() => {
        if (tab === "session" && logFiles.length === 0 && !logLoading) {
            loadSessionLogs();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab]);

    // 打开并预览一个会话日志文件
    const openSessionLog = useCallback(async (name: string) => {
        const myId = ++previewSeqRef.current;
        // 使在途检索失效：否则其响应晚到会把预览切回检索结果列表
        ++searchSeqRef.current;
        setSearching(false);
        setSelectedLog(name);
        setMatches(null);
        setLogLoading(true);
        try {
            // 后端 ReadSessionLog 已剥除 ANSI 控制序列并按行截断
            const content = await SshService.ReadSessionLog(name, 2000);
            if (myId !== previewSeqRef.current) return;
            const plain = content || "";
            setLogContent(
                plain.length > PREVIEW_CHAR_LIMIT
                    ? plain.slice(plain.length - PREVIEW_CHAR_LIMIT)
                    : plain
            );
        } catch (err) {
            if (myId !== previewSeqRef.current) return;
            handleAppError(err);
            setLogContent("");
        } finally {
            if (myId === previewSeqRef.current) setLogLoading(false);
        }
    }, []);

    // 在所有会话日志中检索关键字
    const runSessionSearch = useCallback(async () => {
        const query = logQuery.trim();
        if (!query) {
            ++searchSeqRef.current;
            setMatches(null);
            // 作废在途检索后必须同时复位按钮的忙碌态，否则搜索按钮永久禁用
            setSearching(false);
            return;
        }
        const myId = ++searchSeqRef.current;
        setSearching(true);
        try {
            const result = await SshService.SearchSessionLogs(query, 200);
            if (myId !== searchSeqRef.current) return;
            setMatches(result || []);
        } catch (err) {
            if (myId !== searchSeqRef.current) return;
            handleAppError(err);
            setMatches([]);
        } finally {
            if (myId === searchSeqRef.current) setSearching(false);
        }
    }, [logQuery]);

    // 清空检索：同时作废在途请求，避免清空后又被旧结果回填
    const clearSessionSearch = useCallback(() => {
        ++searchSeqRef.current;
        setLogQuery("");
        setMatches(null);
        setSearching(false);
    }, []);

    // 解析并格式化应用日志行
    const parsedLines = useMemo(() => {
        if (!rawLogs) return [];
        return rawLogs.split("\n").filter(Boolean).map(parseLogLine);
    }, [rawLogs]);

    const isEmpty = !rawLogs || parsedLines.length === 0;
    const previewEmpty = !logContent && !matches;
    const previewLoading = logLoading && !!selectedLog;

    return (
        <div className="flex flex-col gap-3 p-4">
            {/* 页签切换 */}
            <div className="flex items-center gap-1">
                {([
                    { id: "app" as LogTab, label: t("log_tab_app") },
                    { id: "session" as LogTab, label: t("log_tab_session") },
                ]).map(({ id, label }) => (
                    <button
                        key={id}
                        onClick={() => setTab(id)}
                        className={cn(
                            "rounded-[var(--radius-sm)] px-2.5 py-1 text-xs transition-colors",
                            tab === id
                                ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]"
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === "app" ? (
                <>
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="settings-row-title">{t("log_title")}</span>
                            <span className="settings-row-desc">{t("log_desc")}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={loadLogs} disabled={loading}>
                                <RefreshCw className={`mr-1.5 size-3.5 ${loading ? "animate-spin" : ""}`} />
                                {t("log_refresh")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleCopy} disabled={isEmpty}>
                                {copied
                                    ? <><Check className="mr-1.5 size-3.5" />{t("log_copied")}</>
                                    : <><Copy className="mr-1.5 size-3.5" />{t("log_copy")}</>
                                }
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleClear} disabled={isEmpty}>
                                <Trash2 className="mr-1.5 size-3.5" />
                                {t("log_clear")}
                            </Button>
                        </div>
                    </div>
                    {/* select-text 确保可以通过鼠标选中文本复制 */}
                    <div className="h-72 overflow-auto rounded-[var(--radius-md)] border border-[var(--hairline)]
                                    bg-[var(--surface-0)] p-3 select-text">
                        {isEmpty ? (
                            <div className="flex h-full items-center justify-center text-sm text-[var(--fg-muted)]">
                                <ScrollText className="mr-2 size-4" />
                                {t("log_click_refresh")}
                            </div>
                        ) : (
                            <div className="space-y-0.5">
                                {parsedLines.map((line, idx) => (
                                    <div
                                        key={idx}
                                        className={cn(
                                            "flex items-start gap-2 rounded px-1.5 py-0.5 font-mono text-xs leading-relaxed",
                                            getLevelBgColor(line.level)
                                        )}
                                    >
                                        {line.time && (
                                            <span className="shrink-0 text-[var(--fg-subtle)]">
                                                [{line.time}]
                                            </span>
                                        )}
                                        {line.level && (
                                            <span className={cn("shrink-0", getLevelColor(line.level))}>
                                                [{line.level}]
                                            </span>
                                        )}
                                        <span className={cn(
                                            "min-w-0 flex-1 break-all",
                                            line.level === "ERROR" ? "text-destructive" : "text-[var(--fg-muted)]"
                                        )}>
                                            {line.message}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            ) : (
                <>
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="settings-row-title">{t("session_log_viewer_title")}</span>
                            <span className="settings-row-desc">{t("session_log_viewer_desc")}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
                                <Input
                                    value={logQuery}
                                    onChange={(e) => setLogQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") runSessionSearch();
                                        if (e.key === "Escape") clearSessionSearch();
                                    }}
                                    placeholder={t("session_log_search_placeholder")}
                                    className="h-8 w-56 pl-8 text-xs"
                                />
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={runSessionSearch}
                                disabled={searching || !logQuery.trim()}
                            >
                                <Search className={`mr-1.5 size-3.5 ${searching ? "animate-pulse" : ""}`} />
                                {t("session_log_search")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={loadSessionLogs} disabled={logLoading}>
                                <RefreshCw className={`mr-1.5 size-3.5 ${logLoading ? "animate-spin" : ""}`} />
                                {t("log_refresh")}
                            </Button>
                        </div>
                    </div>

                    <div className="flex h-72 overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline)]
                                    bg-[var(--surface-0)]">
                        {/* 日志文件列表 */}
                        <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--hairline)] p-1.5">
                            {logFiles.length === 0 ? (
                                <div className="px-2 py-6 text-center text-xs text-[var(--fg-muted)]">
                                    {logLoading ? t("session_log_loading") : t("session_log_no_files")}
                                </div>
                            ) : (
                                logFiles.map((file) => (
                                    <button
                                        key={file.name}
                                        onClick={() => openSessionLog(file.name)}
                                        className={cn(
                                            "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors",
                                            selectedLog === file.name
                                                ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                                : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
                                        )}
                                    >
                                        <span className="w-full truncate font-mono text-[11px]">{file.name}</span>
                                        <span className="text-[10px] text-[var(--fg-subtle)]">
                                            {formatFileSize(file.size)} · {formatDateTime(file.modTime)}
                                        </span>
                                    </button>
                                ))
                            )}
                        </div>

                        {/* 预览 / 检索结果 */}
                        <div className="min-w-0 flex-1 overflow-auto p-3 select-text">
                            {matches ? (
                                matches.length === 0 ? (
                                    <div className="flex h-full items-center justify-center text-xs text-[var(--fg-muted)]">
                                        {t("session_log_no_matches")}
                                    </div>
                                ) : (
                                    <div className="space-y-1">
                                        {matches.map((m, idx) => (
                                            <button
                                                key={`${m.file}:${m.line}:${idx}`}
                                                onClick={() => openSessionLog(m.file)}
                                                className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left
                                                           transition-colors hover:bg-[var(--surface-2)]"
                                            >
                                                <span className="shrink-0 font-mono text-[10px] text-[var(--fg-subtle)]">
                                                    {m.file}:{m.line}
                                                </span>
                                                <span className="min-w-0 flex-1 break-all font-mono text-xs text-[var(--fg-muted)]">
                                                    {m.text}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )
                            ) : previewLoading ? (
                                <div className="flex h-full items-center justify-center text-xs text-[var(--fg-muted)]">
                                    {t("session_log_loading")}
                                </div>
                            ) : previewEmpty ? (
                                <div className="flex h-full items-center justify-center text-xs text-[var(--fg-muted)]">
                                    <FileText className="mr-2 size-4" />
                                    {t("session_log_select_hint")}
                                </div>
                            ) : (
                                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--fg-muted)]">
                                    {logContent}
                                </pre>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
