import {useState, useEffect, useRef, SyntheticEvent} from "react";
import {useTranslation} from "react-i18next";
import {Tag, FileText, Sparkles, Loader2} from "lucide-react";
import {SavedKey, ItemType, KeyService} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
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
    const [keyType, setKeyType] = useState("ed25519");
    const [rsaBits, setRsaBits] = useState("4096");
    const [generating, setGenerating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 当切换编辑目标时同步表单数据
    useEffect(() => {
        setName(initialData?.name || "");
        setPrivateKey(initialData?.privateKey || "");
        setKeyType("ed25519");
        setRsaBits("4096");
    }, [initialData]);

    const handleFileRead = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (e.target?.result) setPrivateKey(e.target.result as string);
        };
        reader.onerror = () => {
            handleAppError(new Error("读取文件失败"));
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleGenerate = async () => {
        setGenerating(true);
        try {
            const bits = keyType === "rsa" ? parseInt(rsaBits, 10) : 0;
            const key = await KeyService.GenerateKey(keyType, bits);
            setPrivateKey(key);
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

    const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSave(new SavedKey({
            id: initialData?.id || "",
            type: ItemType.TypeKey,
            name,
            privateKey,
        }));
    };

    return (
        <form
            id={KEY_FORM_ID}
            onSubmit={handleSubmit}
            aria-busy={isSaving}
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
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
            </div>
        </form>
    );
}
