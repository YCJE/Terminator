import {useState, useEffect, SyntheticEvent, useMemo} from "react";
import {useTranslation} from "react-i18next";
import {toast} from "sonner";
import {
    Server,
    Tag,
    Folder,
    User,
    KeyRound,
    ShieldCheck,
    Route,
    ChevronDown,
    Eye,
    EyeOff,
} from "lucide-react";
import {Host, ItemType} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {SettingsSwitch} from "@/components/ui/settings-card";
import {useKeys} from "@/hooks/useKeys";
import {useHosts} from "@/hooks/useHosts";
import {cn} from "@/lib/utils";

/** 供详情面板底部的保存按钮以 form 属性关联提交 */
export const HOST_FORM_ID = "host-form";

interface HostFormProps {
    initialData?: Host | null;
    isSaving: boolean;
    onSave: (host: Host) => void;
}

type AuthMethod = "password" | "ask" | "key";

function getDefaultHost(): Partial<Host> {
    return {
        name: "",
        group: "",
        host: "",
        port: 22,
        username: "root",
        password: "",
        keyId: undefined,
    };
}

export function HostForm({initialData, isSaving, onSave}: HostFormProps) {
    const {t} = useTranslation(["hosts", "common"]);
    const [formData, setFormData] = useState<Partial<Host>>(() => initialData || getDefaultHost());
    // 显式认证方式状态，避免派生状态的弹回问题
    const [authMethod, setAuthMethod] = useState<AuthMethod>(() => {
        if (initialData?.keyId) return "key";
        if (initialData?.password) return "password";
        return "ask";
    });
    const [showPassword, setShowPassword] = useState(false);
    const [showProxyPassword, setShowProxyPassword] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);

    const {data: keys} = useKeys();
    const {data: hosts} = useHosts();

    // 收集已有分组用于自动补全
    const existingGroups = useMemo(() => {
        const groups = new Set<string>();
        hosts?.forEach((h) => {
            if (h.group) groups.add(h.group);
        });
        return Array.from(groups).sort();
    }, [hosts]);

    // 可选跳板机候选：排除自身。已配置跳板机的主机也可作为候选，
    // 由此形成多级链式跳转（连接时按链逐级穿透）。
    const jumpHostCandidates = useMemo(
        () => (hosts || []).filter((h) => !!h.id && h.id !== formData.id),
        [hosts, formData.id]
    );

    // 当切换编辑目标（或从新建切换到编辑）时同步表单数据
    useEffect(() => {
        const data = initialData || getDefaultHost();
        setFormData({...data});
        setShowPassword(false);
        setShowProxyPassword(false);
        setAdvancedOpen(false);
        if (initialData?.keyId) {
            setAuthMethod("key");
        } else if (initialData?.password) {
            setAuthMethod("password");
        } else {
            setAuthMethod("ask");
        }
    }, [initialData]);

    const handleAuthMethodChange = (val: AuthMethod) => {
        setAuthMethod(val);
        if (val === "key") {
            setFormData(prev => ({...prev, password: "", keyId: prev.keyId || "none"}));
        } else if (val === "ask") {
            setFormData(prev => ({...prev, password: "", keyId: undefined}));
        } else {
            // password
            setFormData(prev => ({...prev, keyId: undefined}));
        }
    };

    const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();

        // 校验：密钥认证必须选择密钥
        if (authMethod === "key" && (!formData.keyId || formData.keyId === "none")) {
            toast.error(t("select_key_required"));
            return;
        }

        const port = Number(formData.port) || 22;
        const clampedPort = Math.max(1, Math.min(65535, port));

        // 代理校验：选择了代理类型时，地址和端口为必填
        const hasProxyType = formData.proxyType && formData.proxyType !== "none";
        if (hasProxyType) {
            if (!formData.proxyHost?.trim()) {
                toast.error(t("proxy_host_required"));
                return;
            }
            if (!formData.proxyPort || formData.proxyPort < 1 || formData.proxyPort > 65535) {
                toast.error(t("proxy_port_required"));
                return;
            }
        }
        const hasProxy = !!hasProxyType;
        const clampedProxyPort = hasProxy ? Math.max(1, Math.min(65535, formData.proxyPort!)) : undefined;

        const finalHost = new Host({
            ...formData,
            id: formData.id || "",
            type: ItemType.TypeHost,
            port: clampedPort,
            group: formData.group?.trim() || undefined,
            keyId: authMethod === "key" ? (formData.keyId === "none" ? undefined : formData.keyId) : undefined,
            // 如果选择密钥认证，清空密码；「每次询问」不保存密码
            password: authMethod === "key" ? undefined : (authMethod === "ask" ? undefined : formData.password),
            // 清理代理字段：无代理时清空所有代理配置，避免残留
            proxyType: hasProxy ? formData.proxyType : undefined,
            proxyHost: hasProxy ? formData.proxyHost : undefined,
            proxyPort: clampedProxyPort,
            proxyUsername: hasProxy ? (formData.proxyUsername || undefined) : undefined,
            proxyPassword: hasProxy ? (formData.proxyPassword || undefined) : undefined,
            // 清理跳板机字段：未选择或自引用时置空
            jumpHostId: formData.jumpHostId && formData.jumpHostId !== formData.id ? formData.jumpHostId : undefined,
            // 连接后执行：去空白，空值不落库
            onConnect: formData.onConnect?.trim() || undefined,
        });

        onSave(finalHost);
    };

    const proxyEnabled = !!formData.proxyType && formData.proxyType !== "none";

    return (
        <form
            id={HOST_FORM_ID}
            aria-busy={isSaving}
            onSubmit={handleSubmit}
            className={cn("host-form flex flex-col", advancedOpen && "is-adv-open")}
        >
            {/* 地址 + SSH 端口 */}
            <section className="hf-section">
                <div className="hf-section-head">{t("section_address")}</div>

                <div className="hf-input-wrap">
                    <Server/>
                    <Input
                        id="host"
                        placeholder={t("host_placeholder")}
                        aria-label={t("host_ip", {ns: "common"})}
                        required
                        value={formData.host || ""}
                        onChange={(e) => setFormData(prev => ({...prev, host: e.target.value}))}
                    />
                </div>

            </section>

            {/* 常规：名称 / 分组 */}
            <section className="hf-section">
                <div className="hf-section-head">{t("section_general")}</div>

                <div className="hf-input-wrap">
                    <Tag/>
                    <Input
                        id="name"
                        placeholder={t("field_name")}
                        aria-label={t("field_name")}
                        value={formData.name || ""}
                        onChange={(e) => setFormData(prev => ({...prev, name: e.target.value}))}
                    />
                </div>

                <div className="hf-input-wrap">
                    <Folder/>
                    <Input
                        id="group"
                        list="existing-groups"
                        placeholder={t("group_placeholder")}
                        aria-label={t("group_label")}
                        value={formData.group || ""}
                        onChange={(e) => setFormData(prev => ({...prev, group: e.target.value}))}
                    />
                    <datalist id="existing-groups">
                        {existingGroups.map((g) => (
                            <option key={g} value={g}/>
                        ))}
                    </datalist>
                </div>

                <div className="hf-port-row">
                    <span>{t("ssh_port_label")}</span>
                    <Input
                        id="port"
                        type="number"
                        min={1}
                        max={65535}
                        aria-label={t("port", {ns: "common"})}
                        required
                        value={formData.port === undefined ? "" : formData.port}
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setFormData(prev => ({...prev, port: isNaN(val) ? undefined : val}));
                        }}
                    />
                </div>
            </section>

            {/* 凭据 */}
            <section className="hf-section">
                <div className="hf-section-head">{t("section_authentication")}</div>

                <div className="hf-input-wrap">
                    <User/>
                    <Input
                        id="username"
                        placeholder={t("username", {ns: "common"})}
                        aria-label={t("username", {ns: "common"})}
                        required
                        value={formData.username || ""}
                        onChange={(e) => setFormData(prev => ({...prev, username: e.target.value}))}
                    />
                </div>

                <div className="hf-seg" role="tablist" aria-label={t("auth_method_label")}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={authMethod === "password"}
                        className={cn("hf-seg-btn", authMethod === "password" && "is-active")}
                        onClick={() => handleAuthMethodChange("password")}
                    >
                        {t("auth_mode_password")}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={authMethod === "key"}
                        className={cn("hf-seg-btn", authMethod === "key" && "is-active")}
                        onClick={() => handleAuthMethodChange("key")}
                    >
                        {t("auth_mode_key")}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={authMethod === "ask"}
                        className={cn("hf-seg-btn", authMethod === "ask" && "is-active")}
                        onClick={() => handleAuthMethodChange("ask")}
                    >
                        {t("auth_mode_ask")}
                    </button>
                </div>

                {authMethod === "password" ? (
                    <>
                        <div className="hf-input-wrap">
                            <KeyRound/>
                            <Input
                                id="password"
                                type={showPassword ? "text" : "password"}
                                placeholder={t("password_placeholder")}
                                aria-label={t("password_optional")}
                                value={formData.password || ""}
                                onChange={(e) => setFormData(prev => ({...prev, password: e.target.value}))}
                            />
                            <button
                                type="button"
                                className="hf-eye"
                                aria-label={showPassword ? t("password_hide") : t("password_show")}
                                onClick={() => setShowPassword(v => !v)}
                            >
                                {showPassword ? <EyeOff className="size-4"/> : <Eye className="size-4"/>}
                            </button>
                        </div>
                        <div className="hf-switch-row">
                            <span className="hf-switch-label">{t("save_to_vault")}</span>
                            <SettingsSwitch
                                checked={true}
                                onChange={() => handleAuthMethodChange("ask")}
                                label={t("save_to_vault")}
                            />
                        </div>
                    </>
                ) : authMethod === "ask" ? (
                    <p className="hf-hint">{t("ask_on_connect_hint")}</p>
                ) : (
                    <Select
                        value={formData.keyId || "none"}
                        onValueChange={(val) =>
                            setFormData(prev => ({...prev, keyId: val === "none" ? undefined : val}))}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={t("select_key_placeholder")}/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">{t("none_use_password")}</SelectItem>
                            {keys?.map((key) => (
                                <SelectItem key={key.id} value={key.id}>
                                    {key.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </section>

            {/* 更多：跳板机 / 代理 / Agent 转发 / 连接后执行 */}
            <section className="hf-section">
                <button
                    type="button"
                    className="hf-adv-toggle"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen(v => !v)}
                >
                    <span>{t("advanced_toggle")}</span>
                    <ChevronDown className="hf-chev size-3.5"/>
                </button>

                <div className="hf-adv-body">
                    <div className="hf-switch-row hf-boxed">
                        <ShieldCheck className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                        <div className="min-w-0 flex-1">
                            <span className="hf-switch-title">{t("agent_forwarding_label")}</span>
                            <p className="hf-hint">{t("agent_forwarding_desc")}</p>
                        </div>
                        <SettingsSwitch
                            checked={!!formData.agentForwarding}
                            onChange={(checked) => setFormData(prev => ({...prev, agentForwarding: checked}))}
                            label={t("agent_forwarding_label")}
                        />
                    </div>

                    <div className="hf-grid-2">
                        <div className="hf-field">
                            <Label>{t("jump_host_label")}</Label>
                            <Select
                                value={formData.jumpHostId || "none"}
                                onValueChange={(val) =>
                                    setFormData(prev => ({
                                        ...prev,
                                        jumpHostId: val === "none" ? undefined : val,
                                    }))
                                }
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue/>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">{t("jump_host_none")}</SelectItem>
                                    {jumpHostCandidates.map((h) => (
                                        <SelectItem key={h.id} value={h.id!}>
                                            {h.name || `${h.username}@${h.host}`}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="hf-field">
                            <Label>{t("proxy_type_label")}</Label>
                            <Select
                                value={formData.proxyType || "none"}
                                onValueChange={(val) =>
                                    setFormData(prev => ({
                                        ...prev,
                                        proxyType: val === "none" ? undefined : val,
                                    }))
                                }
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue/>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">{t("proxy_none")}</SelectItem>
                                    <SelectItem value="http">HTTP</SelectItem>
                                    <SelectItem value="socks5">SOCKS5</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <p className="hf-hint">{t("jump_host_desc")}</p>

                    {/* 代理明细只在选中代理后出现，避免高级区被空字段占满 */}
                    {proxyEnabled && (
                        <div className="hf-adv-group">
                            <div className="hf-grid-host">
                                <div className="hf-field">
                                    <Label htmlFor="proxyHost">{t("proxy_host")}</Label>
                                    <Input
                                        id="proxyHost"
                                        placeholder="127.0.0.1"
                                        value={formData.proxyHost || ""}
                                        onChange={(e) =>
                                            setFormData(prev => ({...prev, proxyHost: e.target.value}))}
                                    />
                                </div>
                                <div className="hf-field">
                                    <Label htmlFor="proxyPort">{t("proxy_port")}</Label>
                                    <Input
                                        id="proxyPort"
                                        type="number"
                                        min={1}
                                        max={65535}
                                        placeholder="1080"
                                        value={formData.proxyPort === undefined ? "" : formData.proxyPort}
                                        onChange={(e) => {
                                            const val = parseInt(e.target.value);
                                            setFormData(prev => ({
                                                ...prev,
                                                proxyPort: isNaN(val) ? undefined : val,
                                            }));
                                        }}
                                    />
                                </div>
                            </div>
                            <div className="hf-grid-2">
                                <div className="hf-field">
                                    <Label htmlFor="proxyUsername">{t("proxy_username")}</Label>
                                    <Input
                                        id="proxyUsername"
                                        value={formData.proxyUsername || ""}
                                        onChange={(e) =>
                                            setFormData(prev => ({...prev, proxyUsername: e.target.value}))}
                                    />
                                </div>
                                <div className="hf-field">
                                    <Label htmlFor="proxyPassword">{t("proxy_password")}</Label>
                                    <div className="relative">
                                        <Input
                                            id="proxyPassword"
                                            type={showProxyPassword ? "text" : "password"}
                                            className="pr-10"
                                            value={formData.proxyPassword || ""}
                                            onChange={(e) =>
                                                setFormData(prev => ({...prev, proxyPassword: e.target.value}))}
                                        />
                                        <button
                                            type="button"
                                            className="hf-eye"
                                            aria-label={showProxyPassword ? t("password_hide") : t("password_show")}
                                            onClick={() => setShowProxyPassword(v => !v)}
                                        >
                                            {showProxyPassword ? <EyeOff className="size-4"/> : <Eye className="size-4"/>}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="hf-field">
                        <Label htmlFor="onConnect">
                            <Route className="size-3.5 text-[var(--fg-subtle)]"/>
                            {t("on_connect_label")}
                        </Label>
                        <Textarea
                            id="onConnect"
                            placeholder={t("on_connect_placeholder")}
                            value={formData.onConnect || ""}
                            onChange={(e) => setFormData(prev => ({...prev, onConnect: e.target.value}))}
                        />
                        <p className="hf-hint">{t("on_connect_desc")}</p>
                    </div>
                </div>
            </section>
        </form>
    );
}
