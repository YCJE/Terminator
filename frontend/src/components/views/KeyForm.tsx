import {useState, useEffect, useRef, SyntheticEvent} from "react";
import {useTranslation} from "react-i18next";
import {KeyRound, X, Tag, FileText, Sparkles, Loader2} from "lucide-react";
import {SavedKey, ItemType} from "../../../bindings/terminator-desktop/backend/internal/services/blob";
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
import {GenerateKey} from "../../../bindings/terminator-desktop/backend/cmd/terminator-desktop/keygen";
import {handleAppError} from "@/lib/error";

interface KeyFormProps {
    initialData?: SavedKey | null;
    isSaving: boolean;
    onSave: (key: SavedKey) => void;
    onCancel: () => void;
}

export function KeyForm({initialData, isSaving, onSave, onCancel}: KeyFormProps) {
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
            const key = await GenerateKey(keyType, bits);
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

    const isEditing = !!initialData;

    return (
        <div className="soft-card lazy-fade-in overflow-hidden rounded-2xl border border-border/60">
            {/* 头部：标题 + 关闭按钮 */}
            <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-6 py-4">
                <div className="flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <KeyRound className="size-5"/>
                    </div>
                    <h2 className="text-base font-semibold text-foreground">
                        {isEditing ? t("edit_title") : t("new_title")}
                    </h2>
                </div>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onCancel}
                    disabled={isSaving}
                    aria-label={t("close", {ns: "common"})}
                >
                    <X className="size-4"/>
                </Button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-6 p-6">
                {/* 密钥详情区 */}
                <section className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <KeyRound className="size-4 text-primary"/>
                        {t("section_key_details")}
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="name">{t("key_name_label")}</Label>
                        <div className="relative">
                            <Tag
                                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
                            <Input
                                id="name"
                                className="pl-9"
                                placeholder={t("key_name_placeholder")}
                                required
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <Label htmlFor="privateKey">{t("private_key_label")}</Label>
                            <div className="flex flex-wrap items-center gap-2">
                                {/* 生成密钥 */}
                                <div className="flex items-center gap-1.5">
                                    <Select value={keyType} onValueChange={setKeyType}>
                                        <SelectTrigger className="h-7 w-[110px] text-xs">
                                            <SelectValue/>
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="ed25519">Ed25519</SelectItem>
                                            <SelectItem value="rsa">RSA</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {keyType === "rsa" && (
                                        <Select value={rsaBits} onValueChange={setRsaBits}>
                                            <SelectTrigger className="h-7 w-[70px] text-xs">
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
                                        size="sm"
                                        className="h-7 text-xs"
                                        onClick={handleGenerate}
                                        disabled={generating}
                                    >
                                        {generating
                                            ? <Loader2 className="mr-1 size-3 animate-spin"/>
                                            : <Sparkles className="mr-1 size-3"/>}
                                        {t("generate")}
                                    </Button>
                                </div>
                                {/* 从文件加载 */}
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
                                    onChange={(e) =>
                                        e.target.files && handleFileRead(e.target.files[0])}
                                />
                            </div>
                        </div>

                        <Textarea
                            id="privateKey"
                            required
                            className="min-h-37.5 max-h-64 overflow-y-auto font-mono text-xs"
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        />
                    </div>
                </section>

                {/* 底部操作按钮 */}
                <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
                    <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
                        {t("cancel", {ns: "common"})}
                    </Button>
                    <Button type="submit" disabled={isSaving || !privateKey}>
                        {isSaving ? t("saving", {ns: "common"}) : t("save_key")}
                    </Button>
                </div>
            </form>
        </div>
    );
}
