import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/ui/settings-card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import type { KnownHostEntry } from "../../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { handleAppError } from "@/lib/error";

/**
 * 已知主机面板：列出首次连接时按 TOFU 固定的主机密钥。
 *
 * 服务器密钥变更（重装系统、更换主机）后连接会被拒绝，用户需在此删除旧记录，
 * 下次连接才会重新固定新密钥。列表为空时说明尚未连接过任何主机。
 */
export function KnownHostsPanel() {
    const {t} = useTranslation(["settings", "common"]);
    const [hosts, setHosts] = useState<KnownHostEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [pendingRemove, setPendingRemove] = useState<KnownHostEntry | null>(null);
    const [removing, setRemoving] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setHosts(await SshService.ListKnownHosts());
        } catch (error) {
            handleAppError(error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const confirmRemove = async () => {
        if (!pendingRemove) return;
        setRemoving(true);
        try {
            await SshService.RemoveKnownHost(pendingRemove.address);
            setPendingRemove(null);
            await refresh();
        } catch (error) {
            handleAppError(error);
        } finally {
            setRemoving(false);
        }
    };

    return (
        <SettingsCard title={t("known_hosts_title")} description={t("known_hosts_desc")}>
            {loading ? (
                <div className="flex items-center justify-center py-8 text-[var(--fg-subtle)]">
                    <Loader2 className="size-4 animate-spin"/>
                </div>
            ) : hosts.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center text-[var(--fg-subtle)]">
                    <ShieldCheck className="size-6"/>
                    <span className="text-[12.5px]">{t("known_hosts_empty")}</span>
                </div>
            ) : (
                hosts.map((host) => (
                    <div key={host.address} className="settings-row">
                        <div className="settings-row-label">
                            <span className="truncate font-mono text-[12.5px] text-[var(--fg-strong)]">
                                {host.address}
                            </span>
                            <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-[var(--fg-subtle)]">
                                <Fingerprint className="size-3 shrink-0"/>
                                {host.fingerprint || t("known_hosts_unknown_fp")}
                            </span>
                            <span className="text-[11px] text-[var(--fg-subtle)]">{host.keyType}</span>
                        </div>
                        <div className="settings-row-control">
                            <Button variant="outline" size="sm" onClick={() => setPendingRemove(host)}>
                                <Trash2 className="mr-1.5 size-3.5"/>
                                {t("known_hosts_remove")}
                            </Button>
                        </div>
                    </div>
                ))
            )}

            <ConfirmModal
                isOpen={pendingRemove !== null}
                onClose={() => setPendingRemove(null)}
                onConfirm={confirmRemove}
                title={t("known_hosts_remove_title")}
                description={t("known_hosts_remove_desc", {address: pendingRemove?.address ?? ""})}
                confirmText={t("known_hosts_remove_confirm")}
                confirmDisabled={removing}
            />
        </SettingsCard>
    );
}
