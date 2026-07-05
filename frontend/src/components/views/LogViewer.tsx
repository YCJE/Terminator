// 日志查看器组件：显示应用日志，支持刷新、复制、清除、鼠标选中复制
// 美化日志格式：[2026-07-06 02:21:29 UTC+8] [INFO] 消息内容
// 按级别着色：INFO=蓝色, ERROR=红色, WARN=黄色, DEBUG=灰色
import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollText, RefreshCw, Copy, Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GetLogs, ClearLogs } from "../../../bindings/terminator-desktop/backend/cmd/terminator-desktop/log";
import { handleAppError } from "@/lib/error";
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
            return "text-red-500 font-semibold";
        case "WARN":
        case "WARNING":
            return "text-amber-500 font-semibold";
        case "INFO":
            return "text-sky-500 font-semibold";
        case "DEBUG":
            return "text-muted-foreground/60";
        default:
            return "text-muted-foreground";
    }
}

function getLevelBgColor(level: string): string {
    switch (level.toUpperCase()) {
        case "ERROR":
            return "bg-red-500/10";
        case "WARN":
        case "WARNING":
            return "bg-amber-500/10";
        case "INFO":
            return "bg-sky-500/5";
        default:
            return "";
    }
}

export function LogViewer() {
    const { t } = useTranslation("settings");
    const [rawLogs, setRawLogs] = useState("");
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    const loadLogs = useCallback(async () => {
        setLoading(true);
        try {
            const content = await GetLogs(500);
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
        try {
            await navigator.clipboard.writeText(rawLogs);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = rawLogs;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [rawLogs]);

    const handleClear = useCallback(async () => {
        try {
            await ClearLogs();
            setRawLogs("");
        } catch (err) {
            handleAppError(err);
        }
    }, []);

    // 解析并格式化日志行
    const parsedLines = useMemo(() => {
        if (!rawLogs) return [];
        return rawLogs.split("\n").filter(Boolean).map(parseLogLine);
    }, [rawLogs]);

    const isEmpty = !rawLogs || parsedLines.length === 0;

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="font-medium">{t("log_title")}</span>
                    <span className="text-xs text-muted-foreground">{t("log_desc")}</span>
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
            <div className="h-72 overflow-auto rounded-lg border border-border bg-zinc-950/80 p-3 select-text">
                {isEmpty ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
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
                                    <span className="shrink-0 text-zinc-500">
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
                                    line.level === "ERROR" ? "text-red-300" : "text-zinc-300"
                                )}>
                                    {line.message}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
