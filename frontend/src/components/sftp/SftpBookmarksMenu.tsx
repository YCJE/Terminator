// SFTP 目录书签菜单：收藏当前目录、一键跳转常用目录。
//
// 书签按主机存于 localStorage（见 lib/sftpBookmarks），
// 面板切换会话时用 scope 重新读取，不会串到其他主机。

import { useEffect, useState } from "react";
import { Folder, Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    addBookmark,
    isBookmarked,
    loadBookmarks,
    removeBookmark,
    type SftpBookmark,
} from "@/lib/sftpBookmarks";

interface SftpBookmarksMenuProps {
    /** 主机作用域（hostId 或 user@host:port） */
    scope: string;
    /** 当前目录，作为"收藏当前目录"的路径 */
    currentPath: string;
    onNavigate: (path: string) => void;
}

export function SftpBookmarksMenu({ scope, currentPath, onNavigate }: SftpBookmarksMenuProps) {
    const { t } = useTranslation("sftp");
    const [open, setOpen] = useState(false);
    const [bookmarks, setBookmarks] = useState<SftpBookmark[]>([]);

    // 切换主机或菜单打开时重新读取：菜单打开时读取可避免其它面板刚添加的书签不显示
    useEffect(() => {
        if (!open) return;
        setBookmarks(loadBookmarks(scope));
    }, [open, scope]);

    const handleAdd = () => {
        const next = addBookmark(scope, currentPath);
        setBookmarks(next);
        setOpen(false);
        toast.success(t("bookmark_added"));
    };

    const handleRemove = (id: string) => {
        // 阻止事件冒泡：点击删除不应同时触发菜单项的跳转
        setBookmarks(removeBookmark(scope, id));
    };

    const already = isBookmarked(bookmarks, currentPath);

    return (
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" title={t("bookmarks")}>
                    <Star className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 min-w-56">
                {bookmarks.length === 0 ? (
                    <div className="px-2 py-3 text-center text-[11px] text-[var(--fg-subtle)]">
                        {t("bookmarks_empty")}
                    </div>
                ) : (
                    <div className="flex flex-col">
                        {bookmarks.map((item) => (
                            <div
                                key={item.id}
                                className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--surface-3)]"
                            >
                                <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                    onClick={() => {
                                        setOpen(false);
                                        onNavigate(item.path);
                                    }}
                                    title={item.path}
                                >
                                    <Folder className="size-3.5 shrink-0 text-primary" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-xs">{item.label}</span>
                                        <span className="block truncate font-mono text-[10px] text-[var(--fg-subtle)]">
                                            {item.path}
                                        </span>
                                    </span>
                                </button>
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="opacity-0 group-hover:opacity-100"
                                    title={t("bookmark_remove")}
                                    onClick={() => handleRemove(item.id)}
                                >
                                    <X className="size-3.5" />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleAdd} disabled={already}>
                    <Star className="size-4" />
                    {already ? t("bookmark_exists") : t("bookmark_current")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
