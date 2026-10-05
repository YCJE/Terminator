import {useState, useMemo} from "react";
import {useTranslation} from "react-i18next";
import {
    Plus,
    ArrowRightLeft,
    Network,
    Trash2,
    Globe,
    Server,
    ArrowRight,
} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {SlidePanel} from "@/components/ui/slide-panel";
import {ConfirmModal} from "@/components/ui/confirm-modal";
import {useSessionStore} from "@/store/sessionStore";
import {usePortForwardStore, type TrackedForward} from "@/store/portForwardStore";
import {SshService} from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import {PortForwardSpec} from "../../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import {cn} from "@/lib/utils";
import {toast} from "sonner";

type ForwardType = "local" | "remote";

interface FormState {
    sessionId: string;
    type: ForwardType;
    localHost: string;
    localPort: string;
    remoteHost: string;
    remotePort: string;
}

const DEFAULT_FORM: FormState = {
    sessionId: "",
    type: "local",
    localHost: "127.0.0.1",
    localPort: "",
    remoteHost: "127.0.0.1",
    remotePort: "",
};

export function PortForwardingPage() {
    const {t} = useTranslation(["portForwarding", "common"]);
    const {sessions} = useSessionStore();
    // 转发列表存于全局 store：本页会随视图切换卸载，列表不能只存在于组件本地 state
    const forwards = usePortForwardStore((s) => s.forwards);
    const addForward = usePortForwardStore((s) => s.addForward);
    const removeForward = usePortForwardStore((s) => s.removeForward);
    const restoreForward = usePortForwardStore((s) => s.restoreForward);

    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState<FormState>(DEFAULT_FORM);
    const [isSaving, setIsSaving] = useState(false);
    const [forwardToDelete, setForwardToDelete] = useState<TrackedForward | null>(null);

    // 仅展示已连接（或正在连接）且未断开的会话
    const connectedSessions = useMemo(
        () => sessions.filter((s) => !s.disconnected),
        [sessions]
    );

    const handleOpenForm = () => {
        // 默认选中第一个可用会话
        const defaultSession = connectedSessions[0]?.id || "";
        setFormData({...DEFAULT_FORM, sessionId: defaultSession});
        setShowForm(true);
    };

    // 严格解析端口：只接受 1-65535 的纯数字。
    // 不能用 Math.max/min 夹取，否则负数会被静默夹成 1 而绕过非法校验。
    const parsePort = (val: string): number | null => {
        const trimmed = val.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
        return n;
    };

    const handleSave = async () => {
        if (!formData.sessionId) {
            toast.error(t("placeholder_select_session"));
            return;
        }
        const localPort = parsePort(formData.localPort);
        const remotePort = parsePort(formData.remotePort);
        if (localPort === null || remotePort === null) {
            toast.error(t("invalid_port"));
            return;
        }

        const id = crypto.randomUUID();
        const sessionTitle =
            connectedSessions.find((s) => s.id === formData.sessionId)?.title ||
            formData.sessionId;

        const spec = new PortForwardSpec({
            id,
            sessionId: formData.sessionId,
            type: formData.type,
            localHost: formData.localHost.trim() || "127.0.0.1",
            localPort,
            remoteHost: formData.remoteHost.trim() || "127.0.0.1",
            remotePort,
        });

        setIsSaving(true);
        try {
            await SshService.AddPortForward(spec);
            addForward({...spec, sessionTitle, status: "active" as const});
            setShowForm(false);
        } catch (err) {
            console.error("AddPortForward failed:", err);
            toast.error(String(err));
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeletePrompt = (forward: TrackedForward) => {
        setForwardToDelete(forward);
    };

    const handleConfirmDelete = async () => {
        if (!forwardToDelete) return;
        const target = forwardToDelete;
        setForwardToDelete(null);
        // 先乐观移除，再调用后端
        removeForward(target.id);
        try {
            await SshService.RemovePortForward(target.id);
        } catch (err) {
            console.error("RemovePortForward failed:", err);
            toast.error(String(err));
            // 失败时恢复条目
            restoreForward(target);
        }
    };

    return (
        <div className="flex h-full w-full overflow-hidden">
        <div className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {/* 工具条：标题 + 计数 + 添加按钮 */}
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--hairline)] px-6 pt-4 pb-3">
                <h1 className="shrink-0 text-base font-semibold tracking-tight text-[var(--fg-strong)]">
                    {t("title")}
                </h1>
                <span className="shrink-0 rounded-[5px] border border-[var(--hairline)] bg-[var(--surface-2)]
                                 px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--fg-subtle)]">
                    {forwards.length}
                </span>
                <div className="flex-1"/>
                <Button
                    onClick={handleOpenForm}
                    className="h-[var(--control-height)] shrink-0"
                    disabled={connectedSessions.length === 0}
                    title={
                        connectedSessions.length === 0
                            ? t("no_sessions")
                            : undefined
                    }
                >
                    <Plus/>
                    {t("add_button")}
                </Button>
            </div>

            {/* 列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {/* 空状态 */}
                {forwards.length === 0 && (
                    <div
                        className="soft-card mt-4 flex flex-col items-center justify-center py-20 text-center
                                   rounded-xl"
                    >
                        <div
                            className="mb-4 flex size-12 items-center justify-center rounded-xl
                                       bg-primary/10 text-primary"
                        >
                            <ArrowRightLeft className="size-6"/>
                        </div>
                        <h3 className="text-lg font-semibold text-[var(--fg-strong)]">
                            {t("empty_title")}
                        </h3>
                        <p className="mb-4 mt-2 max-w-md text-sm text-[var(--fg-muted)]">
                            {t("empty_desc")}
                        </p>
                        {connectedSessions.length === 0 ? (
                            <p className="text-xs text-[var(--fg-muted)]">{t("no_sessions")}</p>
                        ) : (
                            <Button variant="outline" onClick={handleOpenForm}>
                                <Plus/>
                                {t("add_button")}
                            </Button>
                        )}
                    </div>
                )}

                {/* 端口转发列表 */}
                {forwards.length > 0 && (
                    <div className="list-rows mt-2">
                        {forwards.map((forward) => (
                            <PortForwardCard
                                key={forward.id}
                                forward={forward}
                                onDelete={() => handleDeletePrompt(forward)}
                            />
                        ))}
                    </div>
                )}

                {/* 删除确认 */}
                <ConfirmModal
                    isOpen={!!forwardToDelete}
                    onClose={() => setForwardToDelete(null)}
                    onConfirm={handleConfirmDelete}
                    title={t("title")}
                    description={`${forwardToDelete?.localHost}:${forwardToDelete?.localPort} → ${forwardToDelete?.remoteHost}:${forwardToDelete?.remotePort}`}
                    confirmText={t("delete", {ns: "common"})}
                    isDestructive={true}
                />
            </div>
        </div>

            {/* 添加表单侧滑面板 */}
            <SlidePanel
                open={showForm}
                onClose={() => setShowForm(false)}
                title={t("panel_title_new")}
                footer={
                    <div className="flex items-center justify-end gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setShowForm(false)}
                            disabled={isSaving}
                        >
                            {t("btn_cancel")}
                        </Button>
                        <Button onClick={handleSave} disabled={isSaving || !formData.sessionId}>
                            {t("btn_save")}
                        </Button>
                    </div>
                }
            >
                <PortForwardForm
                    formData={formData}
                    onChange={setFormData}
                    connectedSessions={connectedSessions}
                />
            </SlidePanel>
        </div>
    );
}

/* ------------------------------ 端口转发卡片 ------------------------------ */

interface PortForwardCardProps {
    forward: TrackedForward;
    onDelete: () => void;
}

function PortForwardCard({forward, onDelete}: PortForwardCardProps) {
    const {t} = useTranslation(["portForwarding", "common"]);
    const isLocal = forward.type === "local";
    const isActive = forward.status === "active";
    const Icon = isLocal ? ArrowRightLeft : Network;

    return (
        <div className="list-row group">
            {/* 类型图标 */}
            <span
                className="list-chip is-tinted"
                style={{["--chip-tint" as string]: isLocal ? "var(--primary)" : "var(--info)"}}
            >
                <Icon className="size-3.5"/>
            </span>

            {/* 主信息：本地地址 → 远程地址 */}
            <span className="list-mono is-strong">
                {forward.localHost}:{forward.localPort}
                <ArrowRight className="list-arrow size-3.5"/>
                {forward.remoteHost}:{forward.remotePort}
            </span>

            {/* 次信息：所属会话 */}
            <span className="list-tag is-icon" title={forward.sessionTitle}>
                <Server className="size-3 shrink-0"/>
                <span>{forward.sessionTitle}</span>
            </span>

            {/* 状态 */}
            <span className={cn("status-pill", isActive && "is-active")}>
                <span className="dot"/>
                {isActive ? t("forward_active") : t("forward_stopped")}
            </span>

            {/* 删除按钮 */}
            <div className="list-actions">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onDelete}
                    className="text-[var(--fg-muted)] hover:text-destructive"
                    title={t("delete", {ns: "common"})}
                >
                    <Trash2 className="size-4"/>
                </Button>
            </div>
        </div>
    );
}

/* ------------------------------ 端口转发表单 ------------------------------ */

interface PortForwardFormProps {
    formData: FormState;
    onChange: (data: FormState) => void;
    connectedSessions: {id: string; title: string}[];
}

function PortForwardForm({formData, onChange, connectedSessions}: PortForwardFormProps) {
    const {t} = useTranslation(["portForwarding", "common"]);

    const update = (patch: Partial<FormState>) => {
        onChange({...formData, ...patch});
    };

    return (
        <div className="flex flex-col gap-6">
            {/* 会话选择 */}
            <div className="grid gap-2">
                <Label>{t("label_session")}</Label>
                {connectedSessions.length === 0 ? (
                    <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--fg-muted)]">
                        {t("no_sessions")}
                    </p>
                ) : (
                    <Select
                        value={formData.sessionId}
                        onValueChange={(val) => update({sessionId: val})}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={t("placeholder_select_session")}/>
                        </SelectTrigger>
                        <SelectContent>
                            {connectedSessions.map((s) => (
                                <SelectItem key={s.id} value={s.id}>
                                    {s.title}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>

            {/* 转发类型 */}
            <div className="grid gap-2">
                <Label>{t("label_type")}</Label>
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        type="button"
                        variant={formData.type === "local" ? "default" : "outline"}
                        onClick={() => update({type: "local"})}
                        className="justify-center"
                    >
                        <ArrowRightLeft/>
                        {t("type_local")}
                    </Button>
                    <Button
                        type="button"
                        variant={formData.type === "remote" ? "default" : "outline"}
                        onClick={() => update({type: "remote"})}
                        className="justify-center"
                    >
                        <Network/>
                        {t("type_remote")}
                    </Button>
                </div>
                <p className="text-xs text-[var(--fg-muted)]">
                    {formData.type === "local" ? t("desc_local") : t("desc_remote")}
                </p>
            </div>

            {/* 本地地址 / 端口：地址占 3/4，端口占 1/4，端口不加图标 */}
            <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3 grid gap-2">
                    <Label htmlFor="localHost">{t("label_local_host")}</Label>
                    <div className="relative">
                        <Globe
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                        <Input
                            id="localHost"
                            className="pl-9"
                            placeholder="127.0.0.1"
                            value={formData.localHost}
                            onChange={(e) => update({localHost: e.target.value})}
                        />
                    </div>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="localPort">{t("label_local_port")}</Label>
                    <Input
                        id="localPort"
                        type="number"
                        min={1}
                        max={65535}
                        placeholder="8080"
                        value={formData.localPort}
                        onChange={(e) => update({localPort: e.target.value})}
                    />
                </div>
            </div>

            {/* 远程地址 / 端口 */}
            <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3 grid gap-2">
                    <Label htmlFor="remoteHost">{t("label_remote_host")}</Label>
                    <div className="relative">
                        <Globe
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-subtle)]"/>
                        <Input
                            id="remoteHost"
                            className="pl-9"
                            placeholder="127.0.0.1"
                            value={formData.remoteHost}
                            onChange={(e) => update({remoteHost: e.target.value})}
                        />
                    </div>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="remotePort">{t("label_remote_port")}</Label>
                    <Input
                        id="remotePort"
                        type="number"
                        min={1}
                        max={65535}
                        placeholder="80"
                        value={formData.remotePort}
                        onChange={(e) => update({remotePort: e.target.value})}
                    />
                </div>
            </div>
        </div>
    );
}
