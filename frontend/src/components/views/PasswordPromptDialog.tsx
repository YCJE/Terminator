import { useState, useEffect, useRef } from "react";
import {useTranslation} from "react-i18next";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {KeyRound} from "lucide-react";

interface PasswordPromptDialogProps {
    isOpen: boolean;
    hostName: string;
    onClose: () => void;
    onConfirm: (password: string) => void;
}

export function PasswordPromptDialog({isOpen, hostName, onClose, onConfirm}: PasswordPromptDialogProps) {
    const {t} = useTranslation(["hosts", "common"]);
    const [password, setPassword] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setPassword("");
        }
    }, [isOpen]);

    const handleClose = () => {
        setPassword("");
        onClose();
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (password) {
            onConfirm(password);
            setPassword("");
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent
                className="sm:max-w-sm"
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    inputRef.current?.focus();
                }}
            >
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <KeyRound className="size-5" />
                    </div>
                    <DialogTitle>{t("enter_password_title")}</DialogTitle>
                    <DialogDescription>
                        {t("enter_password_desc", {name: hostName})}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="grid gap-4 py-2">
                    <div className="grid gap-2">
                        <Label htmlFor="prompt-password">{t("password", {ns: "common"})}</Label>
                        <Input
                            id="prompt-password"
                            ref={inputRef}
                            type="password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={handleClose}>
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
