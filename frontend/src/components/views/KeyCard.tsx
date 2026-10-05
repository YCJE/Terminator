import { Key, MoreHorizontal, Edit, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SavedKey } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { useTranslation } from "react-i18next";

interface KeyCardProps {
    savedKey: SavedKey;
    onEdit: (key: SavedKey) => void;
    onDelete: (key: SavedKey) => void;
}

export function KeyCard({savedKey, onEdit, onDelete}: KeyCardProps) {
    const {t} = useTranslation();
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onEdit(savedKey)}
            onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    onEdit(savedKey);
                }
            }}
            className="list-row is-interactive group"
        >
            <span className="list-chip">
                <Key className="size-3.5" />
            </span>

            <span className="list-primary">{savedKey.name}</span>

            <div className="list-actions" onClick={(e) => e.stopPropagation()}>
                <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="size-4 text-[var(--fg-muted)]"/>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40 z-50">
                        <DropdownMenuItem onClick={() => onEdit(savedKey)}>
                            <Edit className="mr-2 size-4"/>
                            {t("edit")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem
                            onClick={() => onDelete(savedKey)}
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                            <Trash2 className="mr-2 size-4"/>
                            {t("delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}