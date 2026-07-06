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
import {SshService} from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import {PortForwardSpec} from "../../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import {cn} from "@/lib/utils";
import {toast} from "sonner";
import {Events} from "@wailsio/runtime";
import {AppEvent} from "@/lib/events";
import {useEffect} from "react";

type ForwardType = "local" | "remote";

/** 本页跟踪的端口转发条目，附带展示用的会话标题与运行状态 */
interface TrackedForward extends PortForwardSpec {
    sessionTitle: string;
    status: "active" | "stopped";
}

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

    const [forwards, setForwards] = useState<TrackedForward[]>([]);
    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState<FormState>(DEFAULT_FORM);
    const [isSaving, setIsSaving] = useState(false);
    const [forwardToDelete, setForwardToDelete] = useState<TrackedForward | null>(null);

    // 仅展示已连接（或正在连接）且未断开的会话
    const connectedSessions = useMemo(
        () => sessions.filter((s) => !s.disconnected),
        [sessions]
    );

    // 监听会话断开事件，同步更新转发状态
    useEffect(() => {
        const unsubscribe = Events.On(AppEvent.SshClosed, (event) => {
            const data = event?.data as { id?: string } | null;
            if (data?.id) {
                setForwards((prev) =>
                    prev.map((f) =>
                        f.sessionId === data.id
                            ? { ...f, status: "stopped" as const }
                            : f
                    )
                );
            }
        });
        return () => {
            unsubscribe();
        };
    }, []);

    const handleOpenForm = () => {
        // 默认选中第一个可用会话
        const defaultSession = connectedSessions[0]?.id || "";
        setFormData({...DEFAULT_FORM, sessionId: defaultSession});
        setShowForm(true);
    };

    const clampPort = (val: string): number => {
        const n = parseInt(val, 10);
        if (isNaN(n)) return 0;
        return Math.max(1, Math.min(65535, n));
    };

    const handleSave = async () => {
        if (!formData.sessionId) {
            toast.error(t("placeholder_select_session"));
            return;
        }
        const localPort = clampPort(formData.localPort);
        const remotePort = clampPort(formData.remotePort);
        if (localPort <= 0 || remotePort <= 0) {
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
            setForwards((prev) => [
                ...prev,
                {...spec, sessionTitle, status: "active" as const},
            ]);
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
        setForwards((prev) => prev.filter((f) => f.id !== target.id));
        try {
            await SshService.RemovePortForward(target.id);
        } catch (err) {
            console.error("RemovePortForward failed:", err);
            toast.error(String(err));
            // 失败时恢复条目
            setForwards((prev) => [...prev, target]);
        }
    };

    return (
        <div className="flex h-full w-full overflow-hidden">
        <div
            className="lazy-fade-in flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-8"
        >
            {/* 头部：标题 + 添加按钮 */}
            <div className="mb-8 flex w-full items-center gap-4">
                <h1 className="shrink-0 text-2xl font-bold tracking-tight text-foreground">
                    {t("title")}
                </h1>
                <div className="flex-1"/>
                <Button
                    onClick={handleOpenForm}
                    className="shrink-0"
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

            {/* 空状态 */}
            {forwards.length === 0 && (
                <div
                    className="soft-card flex flex-col items-center justify-center py-20 text-center
                               rounded-xl"
                >
                    <div
                        className="mb-4 flex size-12 items-center justify-center rounded-xl
                                   bg-primary/10 text-primary"
                    >
                        <ArrowRightLeft className="size-6"/>
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">
                        {t("empty_title")}
                    </h3>
                    <p className="mb-4 mt-2 max-w-md text-sm text-muted-foreground">
                        {t("empty_desc")}
                    </p>
                    {connectedSessions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("no_sessions")}</p>
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
                <div
                    className="grid w-full gap-4"
                    style={{gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))"}}
                >
                    {forwards.map((forward, index) => (
                        <div
                            key={forward.id}
                            className="stagger-in"
                            style={{["--stagger-index" as string]: index}}
                        >
                            <PortForwardCard
                                forward={forward}
                                onDelete={() => handleDeletePrompt(forward)}
                            />
                        </div>
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
    const Icon = isLocal ? ArrowRightLeft : Network;

    return (
        <div
            className="soft-card group flex items-center gap-4 rounded-xl border border-border
                       p-5 transition-all hover:border-primary/40 hover:shadow-md"
        >
            {/* 类型图标 */}
            <div
                className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-lg",
                    isLocal
                        ? "bg-primary/10 text-primary"
                        : "bg-emerald-500/10 text-emerald-500"
                )}
            >
                <Icon className="size-5"/>
            </div>

            {/* 中间信息 */}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground">
                    <span className="truncate">{forward.localHost}:{forward.localPort}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground"/>
                    <span className="truncate">{forward.remoteHost}:{forward.remotePort}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Server className="size-3.5 shrink-0"/>
                    <span className="truncate">{forward.sessionTitle}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span
                        className={cn(
                            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            forward.status === "active"
                                ? "bg-success/10 text-success"
                                : "bg-muted text-muted-foreground"
                        )}
                    >
                        <span
                            className={cn(
                                "size-1.5 rounded-full",
                                forward.status === "active" ? "bg-success" : "bg-muted-foreground"
                            )}
                        />
                        {forward.status === "active" ? t("forward_active") : t("forward_stopped")}
                    </span>
                </div>
            </div>

            {/* 删除按钮 */}
            <div className="flex shrink-0 items-center">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onDelete}
                    className="text-muted-foreground opacity-0 transition-opacity
                               hover:text-destructive group-hover:opacity-100
                               focus-visible:opacity-100"
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
                    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
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
                <p className="text-xs text-muted-foreground">
                    {formData.type === "local" ? t("desc_local") : t("desc_remote")}
                </p>
            </div>

            {/* 本地地址 / 端口：地址占 3/4，端口占 1/4，端口不加图标 */}
            <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3 grid gap-2">
                    <Label htmlFor="localHost">{t("label_local_host")}</Label>
                    <div className="relative">
                        <Globe
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
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
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
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
