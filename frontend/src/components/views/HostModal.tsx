import { useState, useEffect, SyntheticEvent, useMemo } from "react";
import {useTranslation} from "react-i18next";
import {Host, ItemType} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog";
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

interface HostModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (host: Host) => void;
    initialData?: Host | null;
    isSaving: boolean;
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

export function HostModal({isOpen, onClose, onSave, initialData, isSaving}: HostModalProps) {
    const {t} = useTranslation(["hosts", "common"]);
    const [formData, setFormData] = useState<Partial<Host>>(getDefaultHost);
    // 显式认证方式状态，避免派生状态的弹回问题
    const [authMethod, setAuthMethod] = useState<AuthMethod>("ask");
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

    useEffect(() => {
        if (isOpen) {
            const data = initialData || getDefaultHost();
            setFormData({...data});
            // 根据 initialData 设置认证方式
            if (initialData?.keyId) {
                setAuthMethod("key");
            } else if (initialData?.password) {
                setAuthMethod("password");
            } else {
                setAuthMethod("ask");
            }
        }
    }, [isOpen, initialData]);

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

    const isEditing = !!initialData;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{isEditing ? t("edit_title") : t("new_title")}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="grid gap-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="grid gap-2">
                            <Label htmlFor="name">{t("label_optional", { ns: "common" })}</Label>
                            <Input
                                id="name"
                                placeholder={t("label_placeholder")}
                                value={formData.name || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, name: e.target.value}))}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="group">{t("group_label")}</Label>
                            <Input
                                id="group"
                                list="existing-groups"
                                placeholder={t("group_placeholder")}
                                value={formData.group || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, group: e.target.value}))}
                            />
                            <datalist id="existing-groups">
                                {existingGroups.map((g) => (
                                    <option key={g} value={g} />
                                ))}
                            </datalist>
                        </div>
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                        <div className="col-span-3 grid gap-2">
                            <Label htmlFor="host">{t("host_ip", {ns: "common"})}</Label>
                            <Input
                                id="host"
                                placeholder={t("host_placeholder")}
                                required
                                value={formData.host || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, host: e.target.value}))}
                            />
                        </div>
                        <div className="col-span-1 grid gap-2">
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
                        <Input
                            id="username"
                            required
                            value={formData.username || ""}
                            onChange={(e) =>
                                setFormData(prev => ({...prev, username: e.target.value}))}
                        />
                    </div>

                    {/* 认证方式选择 */}
                    <div className="grid gap-2">
                        <Label>{t("auth_method_label")}</Label>
                        <Select
                            value={authMethod}
                            onValueChange={handleAuthMethodChange}
                        >
                            <SelectTrigger>
                                <SelectValue />
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
                            <Input
                                id="password"
                                type="password"
                                placeholder={t("password_placeholder")}
                                value={formData.password || ""}
                                onChange={(e) =>
                                    setFormData(prev => ({...prev, password: e.target.value}))}
                            />
                        </div>
                    )}

                    {authMethod === "ask" && (
                        <p className="text-xs text-muted-foreground">{t("ask_on_connect_hint")}</p>
                    )}

                    {authMethod === "key" && (
                        <div className="grid gap-2">
                            <Label>{t("ssh_key_label")}</Label>
                            <Select
                                value={formData.keyId || "none"}
                                onValueChange={(val) =>
                                    setFormData(prev => ({...prev, keyId: val === "none" ? undefined : val}))}
                            >
                                <SelectTrigger>
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

                    <div className="mt-4 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit" disabled={isSaving}>
                            {isSaving ? t("saving", {ns: "common"}) : t("save_host")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
