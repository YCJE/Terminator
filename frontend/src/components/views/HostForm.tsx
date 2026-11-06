import {useState, useEffect, SyntheticEvent, useMemo, useRef} from "react";
import {useTranslation} from "react-i18next";
import {toast} from "sonner";
import {Dialogs} from "@wailsio/runtime";
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
    FileKey2,
    PlugZap,
    Loader2,
    CheckCircle2,
    XCircle,
} from "lucide-react";
import {Host, ItemType} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import {TextFileService} from "../../../bindings/terminator-desktop/backend/internal/services/fileio";
import {
    SshService,
    SSHConnectionConfig,
    type ConnectionTestResult,
} from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import {buildSessionParams} from "@/lib/hostConnection";
import {handleAppError} from "@/lib/error";
import {Button} from "@/components/ui/button";
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
import {TERMINAL_ENCODINGS} from "@/lib/terminalEncoding";
import {cn} from "@/lib/utils";

/** 供详情面板底部的保存按钮以 form 属性关联提交 */
export const HOST_FORM_ID = "host-form";

interface HostFormProps {
    initialData?: Host | null;
    isSaving: boolean;
    onSave: (host: Host) => void;
}

type AuthMethod = "password" | "ask" | "key";

/** 常见 TERM 值：老设备往往只识别传统类型，允许手工输入其他值 */
const TERM_TYPES = ["xterm-256color", "xterm", "screen-256color", "vt100", "vt220", "ansi", "linux"];

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
    // 证书文件名仅用于展示（编辑已有主机时无法回溯原文件名）
    const [certFileName, setCertFileName] = useState("");
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
    // 表单版本号：预检期间表单被修改（或切换编辑目标）时递增，
    // 使在途请求返回的旧结果失效，避免把上一次配置的结论展示在新配置上。
    const testVersionRef = useRef(0);

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
        // 切换编辑目标：在途预检的结论属于上一个主机，必须作废
        testVersionRef.current++;
        setFormData({...data});
        setShowPassword(false);
        setShowProxyPassword(false);
        setCertFileName("");
        setAdvancedOpen(false);
        setTestResult(null);
        setTesting(false);
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

    // 把表单值收敛成一份可直接保存/测试的主机配置。
    // 校验失败时返回 null 并给出提示，调用方不再重复校验。
    // 注意：连接预检不经过 <form> 的原生校验（handleTestConnection 直接调用本函数），
    // 因此必填项与端口必须在这里显式校验；同时去掉首尾空白，避免把
    // "  " 这样的主机名/用户名当作有效值保存或发起连接。
    const buildHost = (): Host | null => {
        // 校验：密钥认证必须选择密钥
        if (authMethod === "key" && (!formData.keyId || formData.keyId === "none")) {
            toast.error(t("select_key_required"));
            return null;
        }

        const host = (formData.host || "").trim();
        if (!host) {
            toast.error(t("quick_invalid_host"));
            return null;
        }
        const username = (formData.username || "").trim();
        if (!username) {
            toast.error(t("quick_invalid_username"));
            return null;
        }

        // 端口：留空按默认 22；填了就必须是 1-65535 的整数。
        // 不再静默夹取（把 70000 改成 65535、把 0 改成 22 会让用户以为保存成功）。
        let port = 22;
        if (formData.port !== undefined && formData.port !== null && String(formData.port).trim() !== "") {
            const parsed = Number(formData.port);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
                toast.error(t("quick_invalid_port"));
                return null;
            }
            port = parsed;
        }

        // 代理校验：选择了代理类型时，地址和端口为必填
        const hasProxyType = formData.proxyType && formData.proxyType !== "none";
        if (hasProxyType) {
            if (!formData.proxyHost?.trim()) {
                toast.error(t("proxy_host_required"));
                return null;
            }
            if (!formData.proxyPort || formData.proxyPort < 1 || formData.proxyPort > 65535) {
                toast.error(t("proxy_port_required"));
                return null;
            }
        }
        const hasProxy = !!hasProxyType;
        const clampedProxyPort = hasProxy ? Math.max(1, Math.min(65535, formData.proxyPort!)) : undefined;

        const finalHost = new Host({
            ...formData,
            id: formData.id || "",
            type: ItemType.TypeHost,
            host,
            username,
            port,
            group: formData.group?.trim() || undefined,
            keyId: authMethod === "key" ? (formData.keyId === "none" ? undefined : formData.keyId) : undefined,
            // 如果选择密钥认证，清空密码；「每次询问」不保存密码
            password: authMethod === "key" ? undefined : (authMethod === "ask" ? undefined : formData.password),
            // 交互式认证（MFA/OTP）与证书只对 SSH 认证有意义
            keyboardInteractive: formData.keyboardInteractive || undefined,
            certificate: authMethod === "key" ? (formData.certificate || undefined) : undefined,
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
            // 终端高级参数：空值代表使用默认（xterm-256color / 15s / 30s / UTF-8）
            termType: formData.termType?.trim() || undefined,
            connectTimeout: formData.connectTimeout || undefined,
            keepAlive: formData.keepAlive,
            encoding: formData.encoding && formData.encoding !== "utf-8"
                ? formData.encoding
                : undefined,
        });

        return finalHost;
    };

    const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        const host = buildHost();
        if (host) onSave(host);
    };

    // 证书文件是公开数据（不含私钥），读取内容后随主机一起存入加密 blob，
    // 避免依赖本机路径导致同步/迁移到其他设备后失效。
    const handlePickCertificate = async () => {
        try {
            const picked = await Dialogs.OpenFile({
                Title: t("certificate_import"),
                CanChooseFiles: true,
                CanChooseDirectories: false,
            });
            const path = Array.isArray(picked) ? picked[0] : picked;
            if (!path) return;
            const content = await TextFileService.ReadText(path);
            if (!content.includes("-cert-v01@openssh.com")) {
                toast.error(t("certificate_invalid"));
                return;
            }
            setFormData(prev => ({...prev, certificate: content}));
            setCertFileName(path.split(/[\\/]/).pop() || "");
        } catch (err) {
            const msg = String((err as Error)?.message ?? err ?? "");
            if (!/cancel/i.test(msg)) {
                handleAppError(err);
            }
        }
    };

    const handleClearCertificate = () => {
        setFormData(prev => ({...prev, certificate: undefined}));
        setCertFileName("");
    };

    // 连接预检：使用表单当前值（含跳板/代理/密钥口令）做一次真实握手，
    // 不保存主机、不打开终端，只验证可达性与认证。
    const handleTestConnection = async () => {
        const host = buildHost();
        if (!host) return;
        const version = testVersionRef.current;
        setTesting(true);
        setTestResult(null);
        try {
            const params = buildSessionParams(host, hosts, keys);
            const config = new SSHConnectionConfig({
                id: "preflight",
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password,
                privateKey: params.privateKey,
                privateKeyPassphrase: params.privateKeyPassphrase,
                keyboardInteractive: params.keyboardInteractive,
                certificate: params.certificate,
                jumpHost: params.jumpHost,
                proxyType: params.proxyType,
                proxyHost: params.proxyHost,
                proxyPort: params.proxyPort,
                proxyUsername: params.proxyUsername,
                proxyPassword: params.proxyPassword,
                agentForwarding: params.agentForwarding,
                termType: params.termType,
                connectTimeout: params.connectTimeout,
                keepAlive: params.keepAlive,
                encoding: params.encoding,
            });
            const result = await SshService.TestConnection(config);
            // 预检耗时可能数秒，期间用户改过表单就不再展示旧配置的结果
            if (version === testVersionRef.current) setTestResult(result ?? null);
        } catch (err) {
            handleAppError(err);
        } finally {
            setTesting(false);
        }
    };

    // 任一表单项变化后，旧的预检结果不再可信
    useEffect(() => {
        testVersionRef.current++;
        setTestResult(null);
    }, [formData]);

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

                {/* SSH 证书：仅用于私钥认证，证书内容随主机一起加密存储 */}
                {authMethod === "key" && (
                    <div className="hf-field">
                        <Label>{t("certificate_label")}</Label>
                        {formData.certificate ? (
                            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border
                                            border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-1.5">
                                <FileKey2 className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                                <span
                                    className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg-strong)]"
                                    title={certFileName || t("certificate_loaded_generic")}
                                >
                                    {certFileName || t("certificate_loaded_generic")}
                                </span>
                                <button
                                    type="button"
                                    className="flex size-5 shrink-0 items-center justify-center rounded
                                               text-[var(--fg-subtle)] transition-colors hover:bg-[var(--surface-3)]
                                               hover:text-[var(--destructive)]"
                                    onClick={handleClearCertificate}
                                    title={t("certificate_clear")}
                                    aria-label={t("certificate_clear")}
                                >
                                    <XCircle className="size-3.5"/>
                                </button>
                            </div>
                        ) : (
                            <Button
                                type="button"
                                variant="outline"
                                className="w-full"
                                onClick={handlePickCertificate}
                            >
                                <FileKey2 className="mr-2 size-4"/>
                                {t("certificate_import")}
                            </Button>
                        )}
                        <p className="hf-hint">{t("certificate_hint")}</p>
                    </div>
                )}

                {/* 交互式认证：兼容 keyboard-interactive（MFA/OTP）服务器 */}
                <div className="hf-switch-row hf-boxed">
                    <ShieldCheck className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                    <div className="min-w-0 flex-1">
                        <span className="hf-switch-title">{t("keyboard_interactive_label")}</span>
                        <p className="hf-hint">{t("keyboard_interactive_desc")}</p>
                    </div>
                    <SettingsSwitch
                        checked={!!formData.keyboardInteractive}
                        onChange={(checked) =>
                            setFormData(prev => ({...prev, keyboardInteractive: checked}))}
                        label={t("keyboard_interactive_label")}
                    />
                </div>
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

                    {/* 终端高级参数：只影响会话行为，不改变连接路由 */}
                    <div className="hf-adv-group">
                        <div className="hf-section-head">{t("section_terminal_advanced")}</div>

                        <div className="hf-grid-2">
                            <div className="hf-field">
                                <Label htmlFor="termType">{t("term_type_label")}</Label>
                                <Input
                                    id="termType"
                                    list="term-types"
                                    value={formData.termType || ""}
                                    placeholder={TERM_TYPES[0]}
                                    autoComplete="off"
                                    spellCheck={false}
                                    onChange={(e) =>
                                        setFormData(prev => ({...prev, termType: e.target.value}))}
                                />
                                <datalist id="term-types">
                                    {TERM_TYPES.map((term) => (
                                        <option key={term} value={term}/>
                                    ))}
                                </datalist>
                                <p className="hf-hint">{t("term_type_desc")}</p>
                            </div>

                            <div className="hf-field">
                                <Label>{t("encoding_label")}</Label>
                                <Select
                                    value={formData.encoding || "utf-8"}
                                    onValueChange={(val) =>
                                        setFormData(prev => ({
                                            ...prev,
                                            encoding: val === "utf-8" ? undefined : val,
                                        }))}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TERMINAL_ENCODINGS.map((item) => (
                                            <SelectItem key={item.value} value={item.value}>
                                                {item.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="hf-hint">{t("encoding_desc")}</p>
                            </div>
                        </div>

                        <div className="hf-grid-2">
                            <div className="hf-field">
                                <Label htmlFor="connectTimeout">{t("connect_timeout_label")}</Label>
                                <Input
                                    id="connectTimeout"
                                    type="number"
                                    min={0}
                                    max={120}
                                    value={formData.connectTimeout ?? ""}
                                    placeholder="15"
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        setFormData(prev => ({
                                            ...prev,
                                            connectTimeout: isNaN(val)
                                                ? undefined
                                                : Math.max(0, Math.min(120, val)),
                                        }));
                                    }}
                                />
                                <p className="hf-hint">{t("connect_timeout_desc")}</p>
                            </div>

                            <div className="hf-field">
                                <Label>{t("keepalive_label")}</Label>
                                <Select
                                    value={String(formData.keepAlive ?? 0)}
                                    onValueChange={(val) =>
                                        setFormData(prev => ({
                                            ...prev,
                                            keepAlive: Number(val),
                                        }))}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="0">{t("keepalive_default")}</SelectItem>
                                        <SelectItem value="-1">{t("keepalive_off")}</SelectItem>
                                        <SelectItem value="10">
                                            {t("keepalive_seconds", {seconds: 10})}
                                        </SelectItem>
                                        <SelectItem value="30">
                                            {t("keepalive_seconds", {seconds: 30})}
                                        </SelectItem>
                                        <SelectItem value="60">
                                            {t("keepalive_seconds", {seconds: 60})}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="hf-hint">{t("keepalive_desc")}</p>
                            </div>
                        </div>
                    </div>

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

            {/* 连接预检：不保存、不打开终端，只验证配置能否真正连上 */}
            <section className="hf-section">
                <div className="hf-section-head">{t("section_test_connection")}</div>
                <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleTestConnection}
                    disabled={testing}
                >
                    {testing
                        ? <Loader2 className="mr-2 size-4 animate-spin"/>
                        : <PlugZap className="mr-2 size-4"/>}
                    {testing ? t("testing_connection") : t("test_connection")}
                </Button>
                <p className="hf-hint">{t("test_connection_hint")}</p>

                {testResult && (
                    <div className="flex flex-col gap-1.5 rounded-lg bg-[var(--surface-2)] px-3 py-2">
                        {testResult.steps.map((step) => (
                            <div key={step.key} className="flex items-start gap-2 text-[11.5px]">
                                {step.ok
                                    ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--success)]"/>
                                    : <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive"/>}
                                <span className="shrink-0 text-[var(--fg-strong)]">
                                    {t(`test_step_${step.key}`, {defaultValue: step.key})}
                                </span>
                                <span className="shrink-0 tabular-nums text-[var(--fg-subtle)]">
                                    {step.durationMs} ms
                                </span>
                                {step.detail && (
                                    <span className={cn(
                                        "min-w-0 break-words",
                                        step.ok ? "text-[var(--fg-subtle)]" : "text-destructive"
                                    )}>
                                        {step.detail}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </form>
    );
}
