import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Search, Server, Terminal as TerminalIcon, Settings, KeyRound, Network,
    PanelRight, Radio, Columns2, Rows2, X, Lock, SquarePen, SquareTerminal,
    type LucideIcon,
} from "lucide-react";
import { useHosts } from "@/hooks/useHosts";
import { useKeys } from "@/hooks/useKeys";
import { useSnippetStore } from "@/store/snippetStore";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore, ViewType, type SettingsCategory } from "@/store/uiStore";
import { useAuthStore } from "@/store/authStore";
import { useQueryClient } from "@tanstack/react-query";
import { AuthService } from "../../../bindings/terminator-desktop/backend/internal/services/auth";
import { Host } from "../../../bindings/terminator-desktop/backend/internal/services/blob";
import { buildSessionParams, fallbackHostName } from "@/lib/hostConnection";
import { renderSnippetCommand } from "@/lib/snippets";
import { sendSessionInput } from "@/lib/sessionTransport";
import { comboLabel, isShortcutRecording, matchesCombo } from "@/lib/shortcuts";
import { PasswordPromptDialog } from "@/components/views/PasswordPromptDialog";
import { cn } from "@/lib/utils";

/** 简化的模糊匹配：连续命中加权，返回 -1 表示不匹配 */
function fuzzyScore(query: string, text: string): number {
    const q = query.toLowerCase();
    const target = text.toLowerCase();
    if (!q) return 1;
    const direct = target.indexOf(q);
    if (direct >= 0) return 1000 - direct;

    let cursor = 0;
    let score = 0;
    let streak = 0;
    for (const ch of q) {
        const idx = target.indexOf(ch, cursor);
        if (idx < 0) return -1;
        streak = idx === cursor ? streak + 1 : 0;
        score += 1 + streak;
        cursor = idx + 1;
    }
    return score;
}

type PaletteKind = "host" | "snippet" | "action";

interface PaletteItem {
    key: string;
    kind: PaletteKind;
    label: string;
    hint?: string;
    icon: LucideIcon;
    run: () => void;
}

const SETTINGS_CATEGORIES: { id: SettingsCategory; labelKey: string }[] = [
    { id: "appearance", labelKey: "nav_appearance" },
    { id: "terminal", labelKey: "nav_terminal" },
    { id: "shortcuts", labelKey: "nav_shortcuts" },
    { id: "sync", labelKey: "nav_sync" },
    { id: "security", labelKey: "nav_security" },
    { id: "about", labelKey: "nav_about" },
];

export function CommandPalette() {
    const { t } = useTranslation(["common", "terminal", "settings"]);
    const { data: hosts } = useHosts();
    const { data: keys } = useKeys();
    const snippets = useSnippetStore((s) => s.snippets);
    const loadSnippets = useSnippetStore((s) => s.loadSnippets);
    const sessions = useSessionStore((s) => s.sessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const addSession = useSessionStore((s) => s.addSession);
    const addLocalSession = useSessionStore((s) => s.addLocalSession);
    const removeSession = useSessionStore((s) => s.removeSession);
    const split = useSessionStore((s) => s.split);
    const splitActiveSession = useSessionStore((s) => s.splitActiveSession);
    const closeSplit = useSessionStore((s) => s.closeSplit);
    const clearSessions = useSessionStore((s) => s.clearSessions);
    const isOpen = useUIStore((s) => s.isCommandPaletteOpen);
    const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
    const setActiveView = useUIStore((s) => s.setActiveView);
    const openSettingsSection = useUIStore((s) => s.openSettingsSection);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
    const toggleComposePanel = useUIStore((s) => s.toggleComposePanel);
    const shortcuts = useUIStore((s) => s.shortcuts);
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const toggleBroadcastMode = useSessionStore((s) => s.toggleBroadcastMode);
    const setUnlocked = useAuthStore((s) => s.setUnlocked);
    const queryClient = useQueryClient();

    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const [passwordHost, setPasswordHost] = useState<Host | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const hasSession = !!activeSessionId;
    const hasSessions = sessions.length > 0;
    // 本地终端没有 SFTP 文件面板
    const activeIsLocal = sessions.find((s) => s.id === activeSessionId)?.kind === "local";

    // 全局快捷键：命令面板 + 分屏（捕获阶段注册，终端聚焦时同样生效）
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // 设置页正在录制快捷键时不响应，避免录制按键触发动作
            if (isShortcutRecording()) return;
            const combos = useUIStore.getState().shortcuts;
            if (matchesCombo(e, combos.palette)) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(!useUIStore.getState().isCommandPaletteOpen);
            } else if (matchesCombo(e, combos.splitRow)) {
                e.preventDefault();
                e.stopPropagation();
                if (!useUIStore.getState().isCommandPaletteOpen) {
                    useSessionStore.getState().splitActiveSession("row");
                }
            } else if (matchesCombo(e, combos.splitColumn)) {
                e.preventDefault();
                e.stopPropagation();
                if (!useUIStore.getState().isCommandPaletteOpen) {
                    useSessionStore.getState().splitActiveSession("column");
                }
            } else if (matchesCombo(e, combos.compose)) {
                e.preventDefault();
                e.stopPropagation();
                if (!useUIStore.getState().isCommandPaletteOpen) {
                    useUIStore.getState().toggleComposePanel();
                }
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [setOpen]);

    useEffect(() => {
        if (!isOpen) return;
        setQuery("");
        setActiveIndex(0);
        void loadSnippets();
        const timer = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(timer);
    }, [isOpen, loadSnippets]);

    const handleConnect = (host: Host) => {
        const hasKey = !!host.keyId && !!keys?.some((k) => k.id === host.keyId);
        // 未保存密码且未配置密钥：交给密码对话框，避免直接连接必然失败
        if (!host.password && !hasKey) {
            setOpen(false);
            setPasswordHost(host);
            return;
        }
        addSession(buildSessionParams(host, hosts, keys));
        setOpen(false);
    };

    const runSnippet = (command: string) => {
        const state = useSessionStore.getState();
        const id = state.activeSessionId;
        if (!id) return;
        const session = state.sessions.find((s) => s.id === id);
        sendSessionInput(id, renderSnippetCommand(command, session).replace(/\r\n/g, "\n") + "\n").catch(console.error);
    };

    // 命令项随主机、片段与当前会话状态变化重建
    const items = useMemo<PaletteItem[]>(() => {
        const list: PaletteItem[] = [];

        hosts?.forEach((host) => {
            const name = host.name || fallbackHostName(host.username, host.host);
            list.push({
                key: `host:${host.id}`,
                kind: "host",
                label: name,
                hint: `${host.username}@${host.host}:${host.port}${host.group ? ` · ${host.group}` : ""}`,
                icon: Server,
                run: () => handleConnect(host),
            });
        });

        snippets.forEach((snippet) => {
            if (!hasSession) return;
            list.push({
                key: `snippet:${snippet.id}`,
                kind: "snippet",
                label: snippet.name,
                hint: snippet.command,
                icon: TerminalIcon,
                run: () => {
                    runSnippet(snippet.command);
                    setOpen(false);
                },
            });
        });

        const viewActions: { view: ViewType; labelKey: string; icon: LucideIcon }[] = [
            { view: ViewType.Hosts, labelKey: "palette_action_hosts", icon: Server },
            { view: ViewType.Keys, labelKey: "palette_action_keys", icon: KeyRound },
            { view: ViewType.PortForwarding, labelKey: "palette_action_port_forwarding", icon: Network },
        ];
        viewActions.forEach(({ view, labelKey, icon }) => {
            list.push({
                key: `action:view:${view}`,
                kind: "action",
                label: t(labelKey),
                icon,
                run: () => {
                    setActiveView(view);
                    setOpen(false);
                },
            });
        });

        SETTINGS_CATEGORIES.forEach(({ id, labelKey }) => {
            list.push({
                key: `action:settings:${id}`,
                kind: "action",
                label: `${t("palette_action_settings")} · ${t(labelKey, { ns: "settings" })}`,
                icon: Settings,
                run: () => {
                    openSettingsSection(id);
                    setOpen(false);
                },
            });
        });

        if (hasSessions) {
            list.push({
                key: "action:terminal",
                kind: "action",
                label: t("palette_action_terminal"),
                icon: TerminalIcon,
                run: () => {
                    setActiveView(ViewType.Terminal);
                    setOpen(false);
                },
            });
        }

        list.push({
            key: "action:local-terminal",
            kind: "action",
            label: t("palette_action_local_terminal"),
            icon: SquareTerminal,
            run: () => {
                addLocalSession(t("local_terminal_title"));
                setOpen(false);
            },
        });

        if (hasSession && !activeIsLocal) {
            list.push({
                key: "action:file-panel",
                kind: "action",
                label: t("palette_action_file_panel"),
                hint: isFilePanelVisible ? t("palette_state_on") : t("palette_state_off"),
                icon: PanelRight,
                run: () => {
                    toggleFilePanel();
                    setOpen(false);
                },
            });
        }
        if (hasSession) {
            list.push({
                key: "action:compose",
                kind: "action",
                label: t("palette_action_compose"),
                hint: comboLabel(shortcuts.compose),
                icon: SquarePen,
                run: () => {
                    toggleComposePanel();
                    setOpen(false);
                },
            });
            list.push({
                key: "action:broadcast",
                kind: "action",
                label: t("palette_action_broadcast"),
                hint: broadcastMode ? t("palette_state_on") : t("palette_state_off"),
                icon: Radio,
                run: () => {
                    toggleBroadcastMode();
                    setOpen(false);
                },
            });
            if (!split) {
                list.push({
                    key: "action:split-row",
                    kind: "action",
                    label: t("palette_action_split_row"),
                    hint: comboLabel(shortcuts.splitRow),
                    icon: Columns2,
                    run: () => {
                        splitActiveSession("row");
                        setOpen(false);
                    },
                });
                list.push({
                    key: "action:split-column",
                    kind: "action",
                    label: t("palette_action_split_column"),
                    hint: comboLabel(shortcuts.splitColumn),
                    icon: Rows2,
                    run: () => {
                        splitActiveSession("column");
                        setOpen(false);
                    },
                });
            } else {
                list.push({
                    key: "action:split-close",
                    kind: "action",
                    label: t("split_close", { ns: "terminal" }),
                    icon: X,
                    run: () => {
                        closeSplit();
                        setOpen(false);
                    },
                });
            }
            list.push({
                key: "action:close-tab",
                kind: "action",
                label: t("palette_action_close_tab"),
                icon: X,
                run: () => {
                    if (activeSessionId) removeSession(activeSessionId);
                    setOpen(false);
                },
            });
        }

        list.push({
            key: "action:lock",
            kind: "action",
            label: t("palette_action_lock"),
            icon: Lock,
            run: () => {
                AuthService.LockVault()
                    .then(() => {
                        clearSessions();
                        queryClient.clear();
                        setUnlocked(false);
                    })
                    .catch(console.error);
                setOpen(false);
            },
        });

        return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hosts, keys, snippets, sessions.length, activeSessionId, hasSession, hasSessions, activeIsLocal, split, broadcastMode, isFilePanelVisible, shortcuts, t]);

    const filtered = useMemo(() => {
        return items
            .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.hint ?? ""}`) }))
            .filter((entry) => entry.score >= 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.item);
    }, [items, query]);

    useEffect(() => {
        setActiveIndex((idx) => Math.min(idx, Math.max(filtered.length - 1, 0)));
    }, [filtered.length]);

    // 打开期间接管方向键、回车与 Esc
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((idx) => (filtered.length ? (idx + 1) % filtered.length : 0));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((idx) => (filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0));
            } else if (e.key === "Enter") {
                e.preventDefault();
                filtered[activeIndex]?.run();
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [isOpen, filtered, activeIndex, setOpen]);

    // 键盘移动时把选中项滚动到可视区域
    useEffect(() => {
        const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
        node?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const sectionTitle: Record<PaletteKind, string> = {
        host: t("palette_section_hosts"),
        snippet: t("palette_section_snippets"),
        action: t("palette_section_actions"),
    };

    // 按固定顺序分组渲染，同时保留全局索引供键盘使用
    const sections = (["host", "snippet", "action"] as PaletteKind[])
        .map((kind) => ({ kind, items: filtered.filter((item) => item.kind === kind) }))
        .filter((section) => section.items.length > 0);

    return (
        <>
            {isOpen && (
                <div
                    className="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 pt-[12vh] backdrop-blur-[2px]"
                    onClick={() => setOpen(false)}
                >
                    <div
                        className="palette-panel w-[min(620px,92vw)] overflow-hidden rounded-[var(--radius-lg)]
                                   border border-[var(--hairline-strong)] bg-[var(--surface-1)] shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-4 py-3">
                            <Search className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setActiveIndex(0);
                                }}
                                placeholder={t("palette_placeholder")}
                                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--fg-strong)]
                                           outline-none placeholder:text-[var(--fg-subtle)]"
                            />
                            <kbd className="palette-kbd">Esc</kbd>
                        </div>

                        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
                            {filtered.length === 0 && (
                                <div className="px-4 py-6 text-center text-xs text-[var(--fg-muted)]">
                                    {t("palette_empty")}
                                </div>
                            )}
                            {sections.map((section) => (
                                <div key={section.kind}>
                                    <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-subtle)]">
                                        {sectionTitle[section.kind]}
                                    </div>
                                    {section.items.map((item) => {
                                        const index = filtered.indexOf(item);
                                        const Icon = item.icon;
                                        return (
                                            <button
                                                key={item.key}
                                                data-index={index}
                                                onMouseEnter={() => setActiveIndex(index)}
                                                onClick={() => item.run()}
                                                className={cn(
                                                    "flex w-full items-center gap-3 px-4 py-2 text-left",
                                                    index === activeIndex
                                                        ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                                        : "text-[var(--fg-muted)]"
                                                )}
                                            >
                                                <Icon className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                                                <span className="shrink-0 truncate text-[13px]">{item.label}</span>
                                                {item.hint && (
                                                    <span className="ml-auto truncate font-mono text-[11px] text-[var(--fg-subtle)]">
                                                        {item.hint}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>

                        <div className="flex items-center justify-between border-t border-[var(--hairline)] px-4 py-2 text-[11px] text-[var(--fg-subtle)]">
                            <span>{t("palette_hint")}</span>
                            <span className="hidden sm:inline">{comboLabel(shortcuts.palette)}</span>
                        </div>
                    </div>
                </div>
            )}

            <PasswordPromptDialog
                isOpen={!!passwordHost}
                hostName={passwordHost?.name || passwordHost?.host || ""}
                onClose={() => setPasswordHost(null)}
                onConfirm={(password) => {
                    if (passwordHost) {
                        addSession(buildSessionParams(passwordHost, hosts, keys, password));
                    }
                    setPasswordHost(null);
                }}
            />
        </>
    );
}
