import { useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { AppEvent } from "@/lib/events";
import { parseAppError } from "@/lib/error";
import { useSessionStore } from "@/store/sessionStore";

interface AuthPromptItem {
    prompt: string;
    /** 服务器允许明文回显（如用户名） */
    echo: boolean;
}

interface AuthPromptRequest {
    requestId: string;
    sessionId: string;
    host: string;
    username: string;
    instruction?: string;
    prompts: AuthPromptItem[];
}

/** 密码类问题用当前会话已保存的密码预填，减少 MFA 场景的重复输入 */
const PASSWORD_HINT = /password|passphrase|密码|口令/i;

/**
 * 交互式认证（keyboard-interactive / MFA）问答弹窗。
 *
 * 服务器在 SSH 握手阶段提出问题时，后端通过 ssh:auth-prompt 事件推送请求并阻塞
 * 等待；这里弹出输入框，用户提交后回传 SubmitAuthResponses。多台主机并发连接
 * 要求输入时按到达顺序排队，逐个处理。
 */
export function AuthPromptDialog() {
    const {t} = useTranslation(["hosts", "common"]);
    const [queue, setQueue] = useState<AuthPromptRequest[]>([]);
    const [answers, setAnswers] = useState<string[]>([]);
    const [showAnswers, setShowAnswers] = useState(false);
    const [busy, setBusy] = useState(false);
    const firstInputRef = useRef<HTMLInputElement>(null);

    const current = queue[0] ?? null;
    // 会话可能已在标签栏中（连接中），用其配置预填密码问题
    const sessionConfig = useSessionStore((s) =>
        current ? s.sessions.find((item) => item.id === current.sessionId)?.config : undefined
    );

    useEffect(() => {
        const off = Events.On(AppEvent.SshAuthPrompt, (event) => {
            const data = event?.data as AuthPromptRequest | null;
            if (!data?.requestId || !Array.isArray(data.prompts) || data.prompts.length === 0) return;
            setQueue((prev) =>
                prev.some((item) => item.requestId === data.requestId) ? prev : [...prev, data]
            );
        });
        return () => off();
    }, []);

    // 切换请求时重新初始化回答：密码类问题预填会话密码，其余留空
    useEffect(() => {
        if (!current) {
            setAnswers([]);
            setShowAnswers(false);
            return;
        }
        const password = sessionConfig?.password ?? "";
        setAnswers(current.prompts.map((item) => (!item.echo && PASSWORD_HINT.test(item.prompt) ? password : "")));
        setShowAnswers(false);
    }, [current, sessionConfig?.password]);

    // 弹窗出现后聚焦第一个输入框
    useEffect(() => {
        if (!current) return;
        const timer = setTimeout(() => firstInputRef.current?.focus(), 0);
        return () => clearTimeout(timer);
    }, [current]);

    const handleCancel = async () => {
        const request = current;
        if (!request) return;
        // 立即出队，避免用户重复点击取消后残留
        setQueue((prev) => prev.filter((item) => item.requestId !== request.requestId));
        setAnswers([]);
        try {
            await SshService.CancelAuthPrompt(request.requestId);
        } catch {
            // 请求可能已超时失效，取消失败无需打扰用户
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const request = current;
        if (!request || busy) return;
        setBusy(true);
        try {
            await SshService.SubmitAuthResponses(request.requestId, answers);
        } catch (err) {
            toast.error(t("auth_prompt_failed"), {description: parseAppError(err).message});
        } finally {
            setBusy(false);
            setQueue((prev) => prev.filter((item) => item.requestId !== request.requestId));
            setAnswers([]);
        }
    };

    return (
        <Dialog open={!!current} onOpenChange={(open) => !open && void handleCancel()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <ShieldCheck className="size-5"/>
                    </div>
                    <DialogTitle>{t("auth_prompt_title")}</DialogTitle>
                    <DialogDescription>
                        {t("auth_prompt_desc", {
                            host: current?.host ?? "",
                            username: current?.username ?? "",
                        })}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="grid gap-3 py-1">
                    {current?.instruction && (
                        <p className="rounded-md bg-[var(--surface-3)] px-2.5 py-1.5 text-[11.5px] leading-relaxed
                                      text-[var(--fg-muted)]">
                            {current.instruction}
                        </p>
                    )}

                    {current?.prompts.map((item, index) => (
                        <div key={`${index}-${item.prompt}`} className="grid gap-1.5">
                            <Label htmlFor={`auth-prompt-${index}`} className="text-[12px]">
                                {item.prompt}
                            </Label>
                            <Input
                                id={`auth-prompt-${index}`}
                                ref={index === 0 ? firstInputRef : undefined}
                                type={item.echo || showAnswers ? "text" : "password"}
                                autoComplete="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                value={answers[index] ?? ""}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setAnswers((prev) => {
                                        const next = [...prev];
                                        next[index] = value;
                                        return next;
                                    });
                                }}
                            />
                        </div>
                    ))}

                    <div className="flex items-center justify-between gap-2 pt-1">
                        <button
                            type="button"
                            onClick={() => setShowAnswers((v) => !v)}
                            className="flex items-center gap-1 text-[11px] text-[var(--fg-subtle)] transition-colors
                                       hover:text-[var(--fg-strong)]"
                        >
                            {showAnswers ? <EyeOff className="size-3.5"/> : <Eye className="size-3.5"/>}
                            {showAnswers ? t("auth_prompt_hide") : t("auth_prompt_show")}
                        </button>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={() => void handleCancel()}>
                                {t("cancel", {ns: "common"})}
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? t("auth_prompt_submitting") : t("auth_prompt_submit")}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
