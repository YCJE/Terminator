import {useState, useEffect, useRef, SyntheticEvent} from "react";
import {useTranslation} from "react-i18next";
import {Tag, FileText, Sparkles, Loader2, Eye, EyeOff, ShieldCheck, BadgeCheck} from "lucide-react";
import {
    SavedKey,
    ItemType,
    KeyService,
    type KeyValidation,
} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
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
import {handleAppError} from "@/lib/error";
import {cn} from "@/lib/utils";

/** 表单 id：详情面板底部的保存按钮通过 form 属性触发提交 */
export const KEY_FORM_ID = "key-form";

interface KeyFormProps {
    initialData?: SavedKey | null;
    isSaving: boolean;
    onSave: (key: SavedKey) => void;
}

export function KeyForm({initialData, isSaving, onSave}: KeyFormProps) {
    const {t} = useTranslation(["keys", "common"]);
    const [name, setName] = useState(() => initialData?.name || "");
    const [privateKey, setPrivateKey] = useState(() => initialData?.privateKey || "");
    const [passphrase, setPassphrase] = useState(() => initialData?.passphrase || "");
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [keyType, setKeyType] = useState("ed25519");
    const [rsaBits, setRsaBits] = useState("4096");
    const [generating, setGenerating] = useState(false);
    const [validating, setValidating] = useState(false);
    const [validation, setValidation] = useState<KeyValidation | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // 生成密钥是异步且可能耗时数秒：期间用户可能切换到另一把密钥。
    // 记录当前编辑目标 id，返回时比对，避免把新私钥写进另一条记录。
    const editingIdRef = useRef(initialData?.id ?? "");

    // 当切换编辑目标时同步表单数据
    useEffect(() => {
        setName(initialData?.name || "");
        setPrivateKey(initialData?.privateKey || "");
        setPassphrase(initialData?.passphrase || "");
        setShowPassphrase(false);
        setValidation(null);
        setKeyType("ed25519");
        setRsaBits("4096");
        editingIdRef.current = initialData?.id ?? "";
    }, [initialData]);

    const handleFileRead = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (e.target?.result) {
                setPrivateKey(e.target.result as string);
                // 换了一把密钥：旧口令与旧指纹都不再适用
                setPassphrase("");
                setValidation(null);
            }
        };
        reader.onerror = () => {
            handleAppError(new Error("读取文件失败"));
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleGenerate = async () => {
        setGenerating(true);
        const startId = initialData?.id ?? "";
        try {
            const bits = keyType === "rsa" ? parseInt(rsaBits, 10) : 0;
            const key = await KeyService.GenerateKey(keyType, bits);
            // 生成期间已切换编辑对象：表单被重置成另一条记录，此时回填会
            // 覆盖那条记录的私钥且不可恢复，直接丢弃本次生成结果。
            if (editingIdRef.current !== startId) return;
            setPrivateKey(key);
            // 新生成的密钥没有口令，清掉上一个密钥残留的口令输入
            setPassphrase("");
            setValidation(null);
            // 如果名称为空，自动填充默认名称
            if (!name.trim()) {
                const defaultName = keyType === "ed25519"
                    ? `ed25519-${new Date().toISOString().slice(0, 10)}`
                    : `rsa-${rsaBits}-${new Date().toISOString().slice(0, 10)}`;
                setName(defaultName);
            }
        } catch (err) {
            handleAppError(err);
        } finally {
            setGenerating(false);
        }
    };

    /** 校验私钥与口令，返回可展示的类型/指纹；失败时抛出错误。 */
    const validateKey = async (): Promise<KeyValidation> => {
        const result = await KeyService.ValidateKey(privateKey, passphrase);
        if (!result?.valid) {
            throw new Error(t("validate_key_failed"));
        }
        setValidation(result);
        return result;
    };

    const handleValidateClick = async () => {
        setValidating(true);
        try {
            await validateKey();
        } catch (err) {
            setValidation(null);
            handleAppError(err);
        } finally {
            setValidating(false);
        }
    };

    const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (validating) return;
        setValidating(true);
        try {
            // 保存前必须解析成功：加密私钥需要正确口令，避免坏密钥进入保险库
            const result = await validateKey();
            onSave(new SavedKey({
                id: initialData?.id || "",
                type: ItemType.TypeKey,
                name,
                privateKey,
                // 未加密私钥不保留口令：避免用户误以为口令仍在保护密钥
                passphrase: result.encrypted ? passphrase : undefined,
            }));
        } catch (err) {
            setValidation(null);
            handleAppError(err);
        } finally {
            setValidating(false);
        }
    };

    return (
        <form
            id={KEY_FORM_ID}
            onSubmit={handleSubmit}
            aria-busy={isSaving || validating}
            className="host-form flex flex-col gap-5"
        >
            <div className="hf-field">
                <Label htmlFor="name">{t("key_name_label")}</Label>
                <div className="hf-input-wrap">
                    <Tag/>
                    <Input
                        id="name"
                        placeholder={t("key_name_placeholder")}
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </div>
            </div>

            <div className="hf-field">
                <Label>{t("key_type_label")}</Label>
                <div className="hf-seg is-2" role="tablist" aria-label={t("key_type_label")}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={keyType === "ed25519"}
                        className={cn("hf-seg-btn", keyType === "ed25519" && "is-active")}
                        onClick={() => setKeyType("ed25519")}
                    >
                        Ed25519
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={keyType === "rsa"}
                        className={cn("hf-seg-btn", keyType === "rsa" && "is-active")}
                        onClick={() => setKeyType("rsa")}
                    >
                        RSA
                    </button>
                </div>

                {keyType === "rsa" && (
                    <Select value={rsaBits} onValueChange={setRsaBits}>
                        <SelectTrigger className="w-full">
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="2048">2048</SelectItem>
                            <SelectItem value="4096">4096</SelectItem>
                        </SelectContent>
                    </Select>
                )}

                <Button
                    type="button"
                    variant="secondary"
                    className="h-10 w-full"
                    onClick={handleGenerate}
                    disabled={generating}
                >
                    {generating
                        ? <Loader2 className="mr-2 size-4 animate-spin"/>
                        : <Sparkles className="mr-2 size-4"/>}
                    {t("generate")}
                </Button>
            </div>

            <div className="hf-field">
                <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="privateKey">{t("private_key_label")}</Label>
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={handleValidateClick}
                            disabled={validating || !privateKey.trim()}
                        >
                            {validating
                                ? <Loader2 className="mr-1 size-3 animate-spin"/>
                                : <ShieldCheck className="mr-1 size-3"/>}
                            {t("verify_key")}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <FileText className="mr-1 size-3"/>
                            {t("load_from_file")}
                        </Button>
                    </div>
                    <input
                        type="file"
                        ref={fileInputRef}
                        className="hidden"
                        onChange={(e) => {
                            // 某些 WebView 在用户取消选择时仍会触发 change（FileList 为空），
                            // 直接取 files[0] 会得到 undefined 并在 readAsText 处抛错
                            const file = e.target.files?.[0];
                            if (file) handleFileRead(file);
                        }}
                    />
                </div>
                <Textarea
                    id="privateKey"
                    required
                    className="min-h-38 max-h-64 overflow-y-auto rounded-lg border-transparent
                               bg-[var(--surface-2)] font-mono text-xs"
                    value={privateKey}
                    onChange={(e) => { setPrivateKey(e.target.value); setValidation(null); }}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
            </div>

            {/* 加密私钥口令：仅在私钥带口令时需要；保存时随密钥一起进入加密保险库 */}
            <div className="hf-field">
                <Label htmlFor="passphrase">{t("passphrase_label")}</Label>
                <div className="relative">
                    <Input
                        id="passphrase"
                        type={showPassphrase ? "text" : "password"}
                        value={passphrase}
                        onChange={(e) => { setPassphrase(e.target.value); setValidation(null); }}
                        placeholder={t("passphrase_placeholder")}
                        autoComplete="off"
                        className="pr-10"
                    />
                    <button
                        type="button"
                        onClick={() => setShowPassphrase((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-strong)]"
                        aria-label={showPassphrase ? t("hide_passphrase") : t("show_passphrase")}
                        title={showPassphrase ? t("hide_passphrase") : t("show_passphrase")}
                    >
                        {showPassphrase ? <EyeOff className="size-3.5"/> : <Eye className="size-3.5"/>}
                    </button>
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--fg-subtle)]">
                    {t("passphrase_hint")}
                </p>

                {validation && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[11px]">
                        <span className="flex items-center gap-1 text-[var(--success)]">
                            <BadgeCheck className="size-3.5"/>
                            {validation.encrypted ? t("key_encrypted") : t("key_unencrypted")}
                        </span>
                        <span className="text-[var(--fg-muted)]">{validation.keyType}</span>
                        <span
                            className="min-w-0 break-all font-mono text-[var(--fg-subtle)]"
                            title={validation.fingerprint}
                        >
                            {validation.fingerprint}
                        </span>
                    </div>
                )}
            </div>
        </form>
    );
}
