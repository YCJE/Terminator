// 日志查看器组件：显示应用日志，支持刷新、复制、清除、鼠标选中复制
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ScrollText, RefreshCw, Copy, Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GetLogs, ClearLogs } from "../../../bindings/terminator-desktop/backend/cmd/terminator-desktop/log";
import { handleAppError } from "@/lib/error";

export function LogViewer() {
    const { t } = useTranslation("settings");
    const [logs, setLogs] = useState("");
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    const loadLogs = useCallback(async () => {
        setLoading(true);
        try {
            const content = await GetLogs(500);
            setLogs(content || t("log_empty"));
        } catch (err) {
            handleAppError(err);
            setLogs(t("log_load_error"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(logs);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // 回退方案
            const textarea = document.createElement("textarea");
            textarea.value = logs;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [logs]);

    const handleClear = useCallback(async () => {
        try {
            await ClearLogs();
            setLogs(t("log_empty"));
        } catch (err) {
            handleAppError(err);
        }
    }, [t]);

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
                    <Button variant="outline" size="sm" onClick={handleCopy} disabled={!logs || logs === t("log_empty")}>
                        {copied
                            ? <><Check className="mr-1.5 size-3.5" />{t("log_copied")}</>
                            : <><Copy className="mr-1.5 size-3.5" />{t("log_copy")}</>
                        }
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleClear}>
                        <Trash2 className="mr-1.5 size-3.5" />
                        {t("log_clear")}
                    </Button>
                </div>
            </div>
            {/* select-text 确保可以通过鼠标选中文本复制 */}
            <div className="h-64 overflow-auto rounded-lg border border-border bg-muted/30 p-3 select-text">
                {logs ? (
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                        {logs}
                    </pre>
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        <ScrollText className="mr-2 size-4" />
                        {t("log_click_refresh")}
                    </div>
                )}
            </div>
        </div>
    );
}
