import { useState, useEffect, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Server, Shield, ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AuthService } from "../../../bindings/terminator-desktop/backend/internal/services/auth";
import { SyncService } from "../../../bindings/terminator-desktop/backend/internal/services/sync";
import { useAuthStore } from "@/store/authStore";
import { handleAppError } from "@/lib/error";
import { cn, formatServerUrl } from "@/lib/utils.ts";
import { defaultServerUrl } from "@/lib/defaultServer.ts";

type Mode = "select" | "create" | "connect" | "login";

// 主密码强度分级：0 表示未输入，1-4 依次为弱 / 一般 / 较强 / 强。
// 仅作创建时的提示，真正的长度校验由后端负责。
function passwordStrength(password: string): number {
    if (!password) return 0;

    const length = [...password].length;
    let score = 0;
    if (length >= 8) score++;
    if (length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 1) return 1;
    if (score === 2) return 2;
    if (score === 3) return 3;
    return 4;
}

const STRENGTH_LABEL_KEYS = [
    "",
    "password_strength_weak",
    "password_strength_fair",
    "password_strength_good",
    "password_strength_strong",
] as const;

const STRENGTH_COLOR_CLASSES = [
    "",
    "bg-destructive",
    "bg-warning",
    "bg-info",
    "bg-success",
] as const;

export function LockScreen() {
    const {t} = useTranslation(["auth", "common"]);

    const {setHasUser, setUnlocked} = useAuthStore();
    const [mode, setMode] = useState<Mode>("select");
    const [isChecking, setIsChecking] = useState(true);

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [createError, setCreateError] = useState("");
    const [url, setUrl] = useState(defaultServerUrl);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        AuthService.HasUser()
            .then((exists) => {
                setHasUser(exists);
                setMode(exists ? "login" : "select");
            })
            .catch(handleAppError)
            .finally(() => setIsChecking(false));
    }, [setHasUser]);

    const handleLogin = async (e: SyntheticEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            await AuthService.Login(password);
            // Clear sensitive fields from React state before unlocking.
            setPassword("");
            setUnlocked(true);
            // 同步失败不阻塞解锁流程（后端 vault 已解锁）
            try {
                await SyncService.StartAutoSync();
            } catch (syncError) {
                handleAppError(syncError);
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateLocal = async (e: SyntheticEvent) => {
        e.preventDefault();
        // 主密码用于派生加密密钥且无法找回，输错即永久丢失数据，
        // 因此创建前必须做长度与二次确认校验
        if ([...password].length < 6) {
            setCreateError(t("master_password_too_short"));
            return;
        }
        if (password !== confirmPassword) {
            setCreateError(t("password_mismatch"));
            return;
        }
        setCreateError("");
        setIsLoading(true);
        try {
            await AuthService.RegisterLocal(username, password);
            setPassword("");
            setConfirmPassword("");
            setHasUser(true);
            setUnlocked(true);
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleConnectCloud = async (e: SyntheticEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            const cleanUrl = formatServerUrl(url);

            await AuthService.LoginFromSync(cleanUrl, username, password);
            // Clear sensitive fields from React state before unlocking.
            setPassword("");
            setHasUser(true);
            setUnlocked(true);
            // 同步失败不阻塞解锁流程（后端 vault 已解锁）
            try {
                await SyncService.StartAutoSync();
            } catch (syncError) {
                handleAppError(syncError);
            }
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleResetVault = async () => {
        setIsLoading(true);
        try {
            await AuthService.WipeData();
            setHasUser(false);
            setPassword("");
            setConfirmPassword("");
            setCreateError("");
            setUsername("");
            setMode("select");
        } catch (error) {
            handleAppError(error);
        } finally {
            setIsLoading(false);
        }
    };

    const strength = passwordStrength(password);

    if (isChecking) return (
        <div className="flex h-full items-center justify-center bg-[var(--surface-0)] text-[var(--fg-muted)]">
            <span className="mr-3 size-2 rounded-full bg-primary"/>
            {t("initializing")}
        </div>
    );

    return (
        <div className="absolute inset-0 z-50 flex h-full w-full items-center justify-center bg-[var(--surface-0)]">
            <div className="lazy-fade-in relative w-full max-w-sm rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] p-7 shadow-[0_12px_40px_var(--elevate-shadow-2)]">

                {mode !== "select" && mode !== "login" && (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                            setMode("select");
                            setPassword("");
                            setConfirmPassword("");
                            setCreateError("");
                        }}
                        className="absolute left-4 top-4 text-[var(--fg-subtle)]"
                    >
                        <ArrowLeft className="size-4"/>
                    </Button>
                )}

                {mode === "login" && (
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div className="mb-6 flex flex-col items-center text-center">
                            <div className="mb-4 flex size-12 items-center justify-center
                                            rounded-full bg-primary/10 text-primary">
                                <Lock className="size-6"/>
                            </div>
                            <h2 className="text-2xl font-bold tracking-tight text-[var(--fg-strong)]">{t("vault_locked_title")}</h2>
                            <p className="mt-1 text-sm text-[var(--fg-muted)]">{t("vault_locked_desc")}</p>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password-login">{t("master_password")}</Label>
                            <Input
                                id="password-login"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </div>
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? t("unlocking", {ns: "common"}) : t("unlock")}
                        </Button>

                        <div className="pt-2 text-center">
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <button type="button"
                                        className="text-xs text-[var(--fg-subtle)] underline-offset-2
                                                   transition-colors hover:text-destructive hover:underline">
                                        {t("forgot_password")}
                                    </button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle className="flex items-center gap-2">
                                            <AlertTriangle className="size-5 text-destructive"/>
                                            {t("reset_vault_title")}
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            {t("reset_vault_desc")}
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>{t("cancel", {ns: "common"})}</AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={handleResetVault}
                                            className="bg-destructive text-destructive-foreground
                                                       hover:bg-destructive/90">
                                            {t("reset_confirm")}
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </div>
                    </form>
                )}

                {mode === "select" && (
                    <div className="space-y-4">
                        <div className="mb-6 text-center">
                            <img src="/appicon.png" alt="Terminator" className="mx-auto mb-4 size-12 rounded-xl"/>
                            <h2 className="text-2xl font-bold tracking-tight text-[var(--fg-strong)]">{t("welcome_title")}</h2>
                            <p className="mt-1 text-sm text-[var(--fg-muted)]">{t("welcome_desc")}</p>
                        </div>

                        <Button
                            variant="outline"
                            onClick={() => setMode("create")}
                            className="flex h-auto w-full items-center justify-start gap-4 p-4
                                       whitespace-normal text-left"
                        >
                            <div className="flex size-10 shrink-0 items-center justify-center
                                            rounded-lg bg-primary/10 text-primary">
                                <Shield className="size-5"/>
                            </div>
                            <div>
                                <div className="font-medium text-[var(--fg-strong)]">{t("create_local_title")}</div>
                                <div className="text-xs text-[var(--fg-muted)]">{t("create_local_desc")}</div>
                            </div>
                        </Button>

                        <Button
                            variant="outline"
                            onClick={() => setMode("connect")}
                            className="flex h-auto w-full items-center justify-start gap-4 p-4
                                       whitespace-normal text-left"
                        >
                            <div className="flex size-10 shrink-0 items-center justify-center
                                            rounded-lg bg-info/10 text-info">
                                <Server className="size-5"/>
                            </div>
                            <div>
                                <div className="font-medium text-[var(--fg-strong)]">{t("restore_server_title")}</div>
                                <div className="text-xs text-[var(--fg-muted)]">{t("restore_server_desc")}</div>
                            </div>
                        </Button>
                    </div>
                )}

                {mode === "create" && (
                    <form onSubmit={handleCreateLocal} className="space-y-4">
                        <div className="mb-6 mt-2 px-12 text-center">
                            <h2 className="text-xl font-bold tracking-tight text-[var(--fg-strong)]">{t("create_vault_title")}</h2>
                        </div>
                        <div className="space-y-2">
                            <Label>{t("username", {ns: "common"})}</Label>
                            <Input
                                value={username}
                                onChange={(e) =>
                                    setUsername(e.target.value)}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t("master_password")}</Label>
                            <Input
                                type="password"
                                value={password}
                                onChange={(e) => {
                                    setPassword(e.target.value);
                                    setCreateError("");
                                }}
                                required
                            />
                        </div>
                        {password && (
                            <div className="space-y-1">
                                <div className="flex gap-1">
                                    {[1, 2, 3, 4].map((level) => (
                                        <div
                                            key={level}
                                            className={cn(
                                                "h-1 flex-1 rounded-full transition-colors",
                                                level <= strength
                                                    ? STRENGTH_COLOR_CLASSES[strength]
                                                    : "bg-[var(--surface-3)]"
                                            )}
                                        />
                                    ))}
                                </div>
                                <p className={cn(
                                    "text-xs",
                                    strength === 1 ? "text-destructive" : "text-[var(--fg-muted)]"
                                )}>
                                    {t(STRENGTH_LABEL_KEYS[strength])}
                                </p>
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label>{t("confirm_master_password")}</Label>
                            <Input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => {
                                    setConfirmPassword(e.target.value);
                                    setCreateError("");
                                }}
                                required
                            />
                        </div>
                        {createError && (
                            <p className="text-xs text-destructive">{createError}</p>
                        )}
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? t("creating", {ns: "common"}) : t("create_unlock_btn")}
                        </Button>
                    </form>
                )}

                {mode === "connect" && (
                    <form onSubmit={handleConnectCloud} className="space-y-4">
                        <div className="mb-6 mt-2 px-12 text-center">
                            <h2 className="text-xl font-bold tracking-tight text-[var(--fg-strong)]">{t("restore_server_title")}</h2>
                        </div>
                        <div className="space-y-2">
                            <Label>{t("server_url")}</Label>
                            <Input
                                placeholder={defaultServerUrl}
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                required
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>{t("username", {ns: "common"})}</Label>
                                <Input
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>{t("password", {ns: "common"})}</Label>
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(e) =>
                                        setPassword(e.target.value)}
                                    required
                                />
                            </div>
                        </div>
                        <Button type="submit" variant="default"
                                className="w-full bg-info text-info-foreground hover:bg-info/90" disabled={isLoading}>
                            {isLoading ? t("connecting", {ns: "common"}) : t("connect_restore_btn")}
                        </Button>
                    </form>
                )}

            </div>
        </div>
    );
}