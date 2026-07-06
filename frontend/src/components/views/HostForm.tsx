import {useState, useEffect, SyntheticEvent, useMemo} from "react";
import {useTranslation} from "react-i18next";
import {
    Server,
    KeyRound,
    Tag,
    FolderOpen,
    Globe,
    User,
    Lock,
} from "lucide-react";
import {Host, ItemType} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
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
import {useKeys} from "@/hooks/useKeys";
import {useHosts} from "@/hooks/useHosts";

interface HostFormProps {
    initialData?: Host | null;
    isSaving: boolean;
    onSave: (host: Host) => void;
    onCancel: () => void;
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

export function HostForm({initialData, isSaving, onSave, onCancel}: HostFormProps) {
    const {t} = useTranslation(["hosts", "common"]);
    const [formData, setFormData] = useState<Partial<Host>>(() => initialData || getDefaultHost());
    // 显式认证方式状态，避免派生状态的弹回问题
    const [authMethod, setAuthMethod] = useState<AuthMethod>(() => {
        if (initialData?.keyId) return "key";
        if (initialData?.password) return "password";
        return "ask";
    });
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

    // 当切换编辑目标（或从新建切换到编辑）时同步表单数据
    useEffect(() => {
        const data = initialData || getDefaultHost();
        setFormData({...data});
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
            return; // Select 组件已显示"选择密钥"placeholder
        }

        const port = Number(formData.port) || 22;
        const clampedPort = Math.max(1, Math.min(65535, port));

        const finalHost = new Host({
            ...formData,
            id: formData.id || "",
            type: ItemType.TypeHost,
            port: clampedPort,
            group: formData.group?.trim() || undefined,
            keyId: authMethod === "key" ? (formData.keyId === "none" ? undefined : formData.keyId) : undefined,
            // 如果选择密钥认证，清空密码
            password: authMethod === "key" ? undefined : (authMethod === "ask" ? undefined : formData.password),
        });

        onSave(finalHost);
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* 连接信息区 */}
            <section className="flex flex-col gap-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="size-4 text-primary"/>
                    {t("section_connection")}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                        <Label htmlFor="name">{t("label_optional", {ns: "common"})}</Label>
                        <div className="relative">
                            <Tag
                                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                            <Input
                                id="name"
                                className="pl-9"
                                placeholder={t("label_placeholder")}
                                value={formData.name || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, name: e.target.value}))}
                            />
                        </div>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="group">{t("group_label")}</Label>
                        <div className="relative">
                            <FolderOpen
                                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                            <Input
                                id="group"
                                list="existing-groups"
                                className="pl-9"
                                placeholder={t("group_placeholder")}
                                value={formData.group || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, group: e.target.value}))}
                            />
                            <datalist id="existing-groups">
                                {existingGroups.map((g) => (
                                    <option key={g} value={g}/>
                                ))}
                            </datalist>
                        </div>
                    </div>
                </div>

                {/* 主机地址 + 端口：主机占 3/4，端口占 1/4，端口不加图标避免挤压 */}
                <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-3 grid gap-2">
                        <Label htmlFor="host">{t("host_ip", {ns: "common"})}</Label>
                        <div className="relative">
                            <Globe
                                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                            <Input
                                id="host"
                                className="pl-9"
                                placeholder={t("host_placeholder")}
                                required
                                value={formData.host || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, host: e.target.value}))}
                            />
                        </div>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="port">{t("port", {ns: "common"})}</Label>
                        <Input
                            id="port"
                            type="number"
                            min={1}
                            max={65535}
                            required
                            value={formData.port === undefined ? "" : formData.port}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setFormData(prev => ({...prev, port: isNaN(val) ? undefined : val}));
                            }}
                        />
                    </div>
                </div>

                <div className="grid gap-2">
                    <Label htmlFor="username">{t("username", {ns: "common"})}</Label>
                    <div className="relative">
                        <User
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                        <Input
                            id="username"
                            required
                            className="pl-9"
                            value={formData.username || ""}
                            onChange={(e) =>
                                setFormData(prev => ({...prev, username: e.target.value}))}
                        />
                    </div>
                </div>
            </section>

            <div className="h-px w-full bg-border/60"/>

            {/* 身份认证区 */}
            <section className="flex flex-col gap-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <KeyRound className="size-4 text-primary"/>
                    {t("section_authentication")}
                </div>

                {/* 认证方式选择 */}
                <div className="grid gap-2">
                    <Label>{t("auth_method_label")}</Label>
                    <Select
                        value={authMethod}
                        onValueChange={(v) => handleAuthMethodChange(v as AuthMethod)}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="password">{t("auth_save_password")}</SelectItem>
                            <SelectItem value="ask">{t("auth_ask_on_connect")}</SelectItem>
                            <SelectItem value="key">{t("auth_use_key")}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* 根据认证方式显示不同输入框 */}
                {authMethod === "password" && (
                    <div className="grid gap-2">
                        <Label htmlFor="password">{t("password_optional")}</Label>
                        <div className="relative">
                            <Lock
                                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                            <Input
                                id="password"
                                type="password"
                                className="pl-9"
                                placeholder={t("password_placeholder")}
                                value={formData.password || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, password: e.target.value}))}
                            />
                        </div>
                    </div>
                )}

                {authMethod === "ask" && (
                    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        {t("ask_on_connect_hint")}
                    </p>
                )}

                {authMethod === "key" && (
                    <div className="grid gap-2">
                        <Label>{t("ssh_key_label")}</Label>
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
                    </div>
                )}
            </section>

            {/* 底部操作按钮 */}
            <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
                <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
                    {t("cancel", {ns: "common"})}
                </Button>
                <Button type="submit" disabled={isSaving}>
                    {isSaving ? t("saving", {ns: "common"}) : t("save_host")}
                </Button>
            </div>
        </form>
    );
}
