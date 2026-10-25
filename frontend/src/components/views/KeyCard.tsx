import { KeyRound, Edit, Trash2 } from "lucide-react";
import type React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { SavedKey } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface KeyCardProps {
    savedKey: SavedKey;
    selected?: boolean;
    onSelect: (key: SavedKey) => void;
    onDelete: (key: SavedKey) => void;
}

const KEY_TYPE_NAMES: Record<string, string> = {
    "ssh-ed25519": "ED25519",
    "ssh-rsa": "RSA",
    "ecdsa-sha2-nistp256": "ECDSA",
    "ecdsa-sha2-nistp384": "ECDSA",
    "ecdsa-sha2-nistp521": "ECDSA",
    "ssh-dss": "DSA",
};

/**
 * 解析 OpenSSH 私钥容器，读出公钥算法名。
 * 头部只能看出是 OpenSSH 容器，ed25519 / ecdsa / rsa 都写在同一头部里，
 * 需要按 openssh-key-v1 结构跳过 cipher/kdf/kdfoptions 后读取公钥 blob 的类型字符串。
 */
function readOpenSSHKeyType(privateKey: string): string | null {
    try {
        const body = privateKey
            .split(/\r?\n/)
            .filter((line) => !line.startsWith("-----"))
            .join("");
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const magic = "openssh-key-v1\0";
        for (let i = 0; i < magic.length; i++) {
            if (bytes[i] !== magic.charCodeAt(i)) return null;
        }

        let offset = magic.length;
        const readString = (): string => {
            const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
            offset += 4;
            if (length < 0 || offset + length > bytes.length) throw new Error("invalid key");
            const value = String.fromCharCode(...bytes.subarray(offset, offset + length));
            offset += length;
            return value;
        };

        readString(); // ciphername
        readString(); // kdfname
        readString(); // kdfoptions
        offset += 4;  // nkeys
        offset += 4;  // 公钥 blob 的总长度（外层字符串头）
        // 公钥 blob 内部第一个字段才是算法名
        const keyType = readString();
        return KEY_TYPE_NAMES[keyType] || keyType;
    } catch {
        return null;
    }
}

/** 从私钥内容推断算法族，展示为 Termius 卡片副行的 "Type ED25519" */
export function getKeyTypeLabel(privateKey: string): string {
    if ((privateKey || "").includes("BEGIN OPENSSH PRIVATE KEY")) {
        const detected = readOpenSSHKeyType(privateKey);
        if (detected) return detected;
    }

    const head = (privateKey || "").split("\n").find((line) => line.includes("PRIVATE KEY")) || "";
    const upper = head.toUpperCase();
    if (upper.includes("RSA")) return "RSA";
    if (upper.includes("EC")) return "ECDSA";
    if (upper.includes("DSA")) return "DSA";
    if (upper.includes("PGP")) return "PGP";
    if (upper.includes("PUTTY")) return "PPK";
    if (upper.includes("OPENSSH")) return "OpenSSH";
    return "SSH";
}

/**
 * Termius 风格密钥卡片：图标 + 名称 + 类型副行。
 * 单击在右侧详情面板查看/编辑，右键弹出快捷菜单。
 */
export function KeyCard({savedKey, selected, onSelect, onDelete}: KeyCardProps) {
    const {t} = useTranslation(["keys", "common"]);

    return (
        <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger asChild>
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(savedKey)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) {
                            e.preventDefault();
                            onSelect(savedKey);
                        }
                    }}
                    className={cn("card-tile", selected && "is-selected")}
                    title={savedKey.name}
                >
                    <span
                        className="card-tile-icon is-tinted"
                        style={{"--chip-tint": "var(--primary)"} as React.CSSProperties}
                    >
                        <KeyRound className="size-4"/>
                    </span>

                    <span className="card-tile-main">
                        <span className="card-tile-title">
                            <span className="card-tile-name">{savedKey.name}</span>
                        </span>
                        <span className="card-tile-meta">
                            {t("key_type", {type: getKeyTypeLabel(savedKey.privateKey)})}
                        </span>
                    </span>
                </div>
            </ContextMenuPrimitive.Trigger>

            <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.Content className="context-menu-content" collisionPadding={8}>
                    <ContextMenuPrimitive.Item
                        className="context-menu-item"
                        onSelect={() => onSelect(savedKey)}
                    >
                        <Edit className="size-3.5"/>
                        {t("edit", {ns: "common"})}
                    </ContextMenuPrimitive.Item>
                    <ContextMenuPrimitive.Separator className="context-menu-sep"/>
                    <ContextMenuPrimitive.Item
                        className="context-menu-item is-danger"
                        onSelect={() => onDelete(savedKey)}
                    >
                        <Trash2 className="size-3.5"/>
                        {t("delete", {ns: "common"})}
                    </ContextMenuPrimitive.Item>
                </ContextMenuPrimitive.Content>
            </ContextMenuPrimitive.Portal>
        </ContextMenuPrimitive.Root>
    );
}
