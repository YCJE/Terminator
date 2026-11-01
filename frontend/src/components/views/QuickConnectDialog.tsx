import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Zap } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "sonner";

interface QuickConnectDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

/**
 * 解析主机输入中的便捷写法
 * 支持直接粘贴 `user@host:port`（与 ssh 命令行习惯一致），
 * 拆出的用户名/端口仅在对应字段为空时填充，不覆盖用户已填内容。
 */
function parseHostInput(raw: string): { host: string; username: string; port: string } {
    let rest = raw.trim();
    let username = "";
    const at = rest.lastIndexOf("@");
    if (at > 0) {
        username = rest.slice(0, at);
        rest = rest.slice(at + 1);
    }
    let port = "";
    // IPv6 字面量 [::1]:22 的端口在最后一个冒号之后；裸 IPv6 不做拆分
    if (rest.startsWith("[")) {
        const closing = rest.indexOf("]");
        if (closing > 0 && rest[closing + 1] === ":") {
            port = rest.slice(closing + 2);
            rest = rest.slice(0, closing + 1);
        }
    } else {
        const colon = rest.lastIndexOf(":");
        if (colon > 0 && !rest.includes("::")) {
            port = rest.slice(colon + 1);
            rest = rest.slice(0, colon);
        }
    }
    return { host: rest, username, port };
}

export function QuickConnectDialog({ isOpen, onClose }: QuickConnectDialogProps) {
    const { t } = useTranslation(["hosts", "common"]);
    const addSession = useSessionStore((s) => s.addSession);

    const [host, setHost] = useState("");
    const [port, setPort] = useState("22");
    // 端口框是否被用户手动修改过：默认值同样是 "22"，无法靠取值判断，
    // 否则粘贴 "user@host:2222" 时会被默认端口覆盖、静默连到 22
    const [portTouched, setPortTouched] = useState(false);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [title, setTitle] = useState("");
    const hostRef = useRef<HTMLInputElement>(null);

    // 每次打开重置表单并聚焦地址框
    useEffect(() => {
        if (!isOpen) return;
        setHost("");
        setPort("22");
        setPortTouched(false);
        setUsername("");
        setPassword("");
        setTitle("");
    }, [isOpen]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const parsed = parseHostInput(host);
        const finalHost = parsed.host;
        const finalUser = username.trim() || parsed.username;
        // 用户手动改过端口框时以输入框为准；否则优先采用地址里带的端口。
        // 端口框在打开时预填 "22"，无条件取用会让粘贴写法里的端口失效。
        const portText = portTouched ? port.trim() : (parsed.port || port.trim());
        const finalPort = Number(portText || 22);

        if (!finalHost) {
            toast.error(t("quick_invalid_host"));
            hostRef.current?.focus();
            return;
        }
        if (!Number.isInteger(finalPort) || finalPort < 1 || finalPort > 65535) {
            toast.error(t("quick_invalid_port"));
            return;
        }
        if (!finalUser) {
            toast.error(t("quick_invalid_username"));
            return;
        }

        addSession({
            host: finalHost,
            port: finalPort,
            username: finalUser,
            password: password || undefined,
            title: title.trim() || undefined,
        });
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className="sm:max-w-md"
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    hostRef.current?.focus();
                }}
            >
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Zap className="size-5"/>
                    </div>
                    <DialogTitle>{t("quick_connect_title")}</DialogTitle>
                    <DialogDescription>{t("quick_connect_desc")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="grid gap-3 py-1">
                    <div className="grid gap-1.5">
                        <Label htmlFor="qc-host">{t("quick_host_label")}</Label>
                        <Input
                            id="qc-host"
                            ref={hostRef}
                            value={host}
                            onChange={(e) => setHost(e.target.value)}
                            placeholder={t("quick_host_placeholder")}
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>

                    <div className="grid grid-cols-[1fr_96px] gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="qc-user">{t("quick_username_label")}</Label>
                            <Input
                                id="qc-user"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="root"
                                autoComplete="username"
                                spellCheck={false}
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="qc-port">{t("ssh_port_label")}</Label>
                            <Input
                                id="qc-port"
                                value={port}
                                onChange={(e) => {
                                    setPort(e.target.value);
                                    setPortTouched(true);
                                }}
                                placeholder="22"
                                inputMode="numeric"
                                autoComplete="off"
                            />
                        </div>
                    </div>

                    <div className="grid gap-1.5">
                        <Label htmlFor="qc-password">{t("quick_password_label")}</Label>
                        <Input
                            id="qc-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t("quick_password_placeholder")}
                            autoComplete="current-password"
                        />
                    </div>

                    <div className="grid gap-1.5">
                        <Label htmlFor="qc-title">{t("quick_title_label")}</Label>
                        <Input
                            id="qc-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t("label_placeholder")}
                            autoComplete="off"
                        />
                    </div>

                    <div className="mt-1 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit">
                            {t("connect", {ns: "common"})}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
