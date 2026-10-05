import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Download, Loader2, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/ui/settings-card";
import { BackupService } from "../../../bindings/terminator-desktop/backend/internal/services/backup";
import type { BackupFileInfo } from "../../../bindings/terminator-desktop/backend/internal/services/backup/models";
import { useCurrentUser } from "@/hooks/useAuth";
import { handleAppError, parseAppError } from "@/lib/error";
import { ErrorCode } from "@/lib/errorCodes";
import { formatDateTime } from "@/lib/format";
import { useAuthStore } from "@/store/authStore";
import { usePortForwardStore } from "@/store/portForwardStore";
import { useSessionStore } from "@/store/sessionStore";
import { useSyncStore } from "@/store/syncStore";

function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="break-all text-right font-medium text-foreground">{value}</span>
        </div>
    );
}

/**
 * 备份面板：导出加密备份，或从备份文件整体恢复账户与全部条目。
 * 恢复会替换本机全部数据，因此必须"选择文件 → 核对摘要 → 输入密码"确认后才执行。
 */
export function BackupPanel() {
    const { t } = useTranslation(["settings", "common"]);
    const queryClient = useQueryClient();
    const { refetch } = useCurrentUser();
    const setUnlocked = useAuthStore((s) => s.setUnlocked);
    const setHasUser = useAuthStore((s) => s.setHasUser);
    const clearSessions = useSessionStore((s) => s.clearSessions);
    const clearForwards = usePortForwardStore((s) => s.clearAll);
    const refreshConflicts = useSyncStore((s) => s.refreshConflicts);

    const [isExporting, setIsExporting] = useState(false);
    const [exportedPath, setExportedPath] = useState("");
    const [isSelecting, setIsSelecting] = useState(false);
    const [pending, setPending] = useState<BackupFileInfo | null>(null);
    const [password, setPassword] = useState("");
    const [isImporting, setIsImporting] = useState(false);
    const [passwordRejected, setPasswordRejected] = useState(false);

    const handleExport = async () => {
        setIsExporting(true);
        setExportedPath("");
        try {
            const path = await BackupService.ExportBackup();
            // 用户在保存对话框中取消时后端返回空路径，属于正常操作，不提示
            if (path) {
                setExportedPath(path);
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsExporting(false);
        }
    };

    const closeDialog = () => {
        setPending(null);
        setPassword("");
        setPasswordRejected(false);
    };

    const handleSelectBackup = async () => {
        setIsSelecting(true);
        try {
            const info = await BackupService.SelectBackupFile();
            if (info) {
                setPassword("");
                setPasswordRejected(false);
                setPending(info);
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsSelecting(false);
        }
    };

    const handleImport = async () => {
        if (!password) return;
        setIsImporting(true);
        setPasswordRejected(false);
        try {
            await BackupService.ImportBackup(password);
            // 账户与全部条目已被整体替换，后端也已断开所有 SSH 会话与端口转发，
            // 前端必须同步清空，否则会留下指向已消失会话的标签页和转发记录
            clearSessions();
            clearForwards();
            closeDialog();
            queryClient.clear();
            setHasUser(true);
            setUnlocked(true);
            await refetch();
            await refreshConflicts();
            toast.success(t("backup_restore_success"));
        } catch (error) {
            // 密码不符是唯一可预期的失败，内联提示比自动消失的 toast 更便于重试；
            // 其余错误（文件读写、数据库）走统一错误提示，避免被误报成密码问题
            if (parseAppError(error).code === ErrorCode.VALIDATION_FAILED) {
                setPasswordRejected(true);
            } else {
                handleAppError(error);
            }
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <>
            <SettingsCard title={t("backup_title")} description={t("backup_desc")}>
                <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                        <span className="font-medium text-foreground">{t("backup_export_title")}</span>
                        <span className="text-xs text-muted-foreground">{t("backup_export_desc")}</span>
                    </div>
                    <Button variant="outline" onClick={handleExport} disabled={isExporting}>
                        {isExporting ? (
                            <Loader2 className="mr-2 size-4 animate-spin"/>
                        ) : (
                            <Download className="mr-2 size-4"/>
                        )}
                        {t("backup_export_btn")}
                    </Button>
                </div>

                {exportedPath && (
                    <div className="flex flex-col gap-2 rounded-md border border-green-500/30 bg-green-500/5 p-3">
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="size-3.5 text-green-500"/>
                            <span className="text-xs font-medium text-foreground">
                                {t("backup_export_success")}
                            </span>
                        </div>
                        <span className="break-all font-mono text-xs text-muted-foreground">
                            {exportedPath}
                        </span>
                        <span className="text-xs text-muted-foreground">{t("backup_export_hint")}</span>
                    </div>
                )}

                <div className="my-2 h-px w-full bg-border"/>

                <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                        <span className="font-medium text-destructive">{t("backup_import_title")}</span>
                        <span className="text-xs text-muted-foreground">{t("backup_import_desc")}</span>
                    </div>
                    <Button variant="outline" onClick={handleSelectBackup} disabled={isSelecting}>
                        {isSelecting ? (
                            <Loader2 className="mr-2 size-4 animate-spin"/>
                        ) : (
                            <Upload className="mr-2 size-4"/>
                        )}
                        {t("backup_import_btn")}
                    </Button>
                </div>
            </SettingsCard>

            <Dialog
                open={pending !== null}
                onOpenChange={(open) => {
                    // 导入过程中忽略关闭请求（Esc / 点击遮罩 / 关闭按钮）：
                    // 中途关闭会让"密码不正确"的提示无处显示，前后端状态也会不一致
                    if (!open && !isImporting) closeDialog();
                }}
            >
                <DialogContent className="sm:max-w-md" showCloseButton={!isImporting}>
                    <DialogHeader>
                        <div
                            className="mb-2 flex size-10 items-center justify-center rounded-lg
                                       bg-destructive/10 text-destructive">
                            <AlertTriangle className="size-5"/>
                        </div>
                        <DialogTitle>{t("backup_restore_dialog_title")}</DialogTitle>
                        <DialogDescription>{t("backup_restore_dialog_desc")}</DialogDescription>
                    </DialogHeader>

                    {pending && (
                        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4 text-xs">
                            <SummaryRow label={t("backup_restore_file")} value={pending.fileName}/>
                            <SummaryRow label={t("backup_restore_user")} value={pending.username}/>
                            <SummaryRow label={t("backup_restore_items")} value={String(pending.itemCount)}/>
                            <SummaryRow label={t("backup_restore_version")} value={pending.appVersion}/>
                            <SummaryRow
                                label={t("backup_restore_exported_at")}
                                value={formatDateTime(pending.exportedAt)}
                            />
                        </div>
                    )}

                    <div className="flex flex-col gap-2">
                        <Label htmlFor="backup-password">{t("backup_restore_password_label")}</Label>
                        <Input
                            id="backup-password"
                            type="password"
                            autoComplete="off"
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                setPasswordRejected(false);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && password && !isImporting) void handleImport();
                            }}
                        />
                        {passwordRejected && (
                            <span className="text-xs text-destructive">{t("backup_restore_failed")}</span>
                        )}
                    </div>

                    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive"/>
                        <span className="text-xs text-muted-foreground">{t("backup_restore_warning")}</span>
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={closeDialog} disabled={isImporting}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button variant="destructive" onClick={handleImport} disabled={!password || isImporting}>
                            {isImporting && <Loader2 className="mr-2 size-4 animate-spin"/>}
                            {t("backup_restore_confirm_btn")}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
