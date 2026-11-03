import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Search, Server, Terminal as TerminalIcon, Settings, KeyRound, Network,
    PanelRight, Radio, Columns2, Rows2, X, Lock, SquarePen, SquareTerminal, Zap,
    Clock3, SlidersHorizontal, Gauge, AppWindow, FileText, Folder,
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
import { isSshKind } from "@/lib/sessionBackend";
import { loadAllComposeHistory } from "@/lib/commandHistory";
import {
    bumpPaletteUsage,
    hashPaletteKey,
    loadPaletteUsage,
    type PaletteUsageMap,
} from "@/lib/paletteUsage";
import { comboLabel, isShortcutRecording, matchesCombo } from "@/lib/shortcuts";
import { MAX_PANES, countPanes, isPaneSession } from "@/lib/paneLayout";
import { popOutSession } from "@/lib/floatingWindows";
import { SftpService } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
import type { SearchResultEntry } from "../../../bindings/terminator-desktop/backend/internal/services/sftp";
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

type PaletteKind = "session" | "file" | "host" | "snippet" | "command" | "setting" | "action";

/** 分组展示与键盘顺序：会话 → 远端文件 → 主机 → 片段 → 最近命令 → 设置项 → 操作 */
const KIND_ORDER: PaletteKind[] = ["session", "file", "host", "snippet", "command", "setting", "action"];

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
    { id: "system", labelKey: "nav_system" },
    { id: "about", labelKey: "nav_about" },
];

// 具体设置项直达：target 与 SettingsRow 上的 id 对应
const SETTINGS_ITEMS: { target: string; category: SettingsCategory; labelKey: string }[] = [
    { target: "setting-theme", category: "appearance", labelKey: "theme_label" },
    { target: "setting-skin", category: "appearance", labelKey: "skin_label" },
    { target: "setting-language", category: "appearance", labelKey: "language_label" },
    { target: "setting-accent", category: "appearance", labelKey: "accent_color_label" },
    { target: "setting-density", category: "appearance", labelKey: "density_label" },
    { target: "setting-terminal-font-size", category: "terminal", labelKey: "terminal_font_size_label" },
    { target: "setting-terminal-font-family", category: "terminal", labelKey: "terminal_font_family_label" },
    { target: "setting-terminal-line-height", category: "terminal", labelKey: "terminal_line_height_label" },
    { target: "setting-terminal-scrollback", category: "terminal", labelKey: "terminal_scrollback_label" },
    { target: "setting-keyword-highlight", category: "terminal", labelKey: "keyword_highlight_label" },
    { target: "setting-paste-protection", category: "terminal", labelKey: "paste_protection_label" },
    { target: "setting-auto-reconnect", category: "terminal", labelKey: "auto_reconnect_label" },
    { target: "setting-sftp-follow-cwd", category: "terminal", labelKey: "sftp_follow_cwd_label" },
    { target: "setting-command-suggestions", category: "terminal", labelKey: "command_suggestions_label" },
    { target: "setting-monitor-alerts", category: "terminal", labelKey: "monitor_alerts_enabled_label" },
    { target: "setting-monitor-cpu-threshold", category: "terminal", labelKey: "monitor_cpu_threshold_label" },
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
    const layout = useSessionStore((s) => s.layout);
    const splitActiveSession = useSessionStore((s) => s.splitActiveSession);
    const closeSplit = useSessionStore((s) => s.closeSplit);
    const clearSessions = useSessionStore((s) => s.clearSessions);
    const isOpen = useUIStore((s) => s.isCommandPaletteOpen);
    const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
    const setActiveView = useUIStore((s) => s.setActiveView);
    const openSettingsSection = useUIStore((s) => s.openSettingsSection);
    const openSettingsTarget = useUIStore((s) => s.openSettingsTarget);
    const setActiveSession = useSessionStore((s) => s.setActiveSession);
    const isFilePanelVisible = useUIStore((s) => s.isFilePanelVisible);
    const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
    const setFilePanelVisible = useUIStore((s) => s.setFilePanelVisible);
    const requestSftpNavigate = useUIStore((s) => s.requestSftpNavigate);
    const isMonitorPanelVisible = useUIStore((s) => s.isMonitorPanelVisible);
    const toggleMonitorPanel = useUIStore((s) => s.toggleMonitorPanel);
    const toggleComposePanel = useUIStore((s) => s.toggleComposePanel);
    const setQuickConnectOpen = useUIStore((s) => s.setQuickConnectOpen);
    const shortcuts = useUIStore((s) => s.shortcuts);
    const broadcastMode = useSessionStore((s) => s.broadcastMode);
    const toggleBroadcastMode = useSessionStore((s) => s.toggleBroadcastMode);
    const setUnlocked = useAuthStore((s) => s.setUnlocked);
    const queryClient = useQueryClient();

    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const [passwordHost, setPasswordHost] = useState<Host | null>(null);
    // 使用频次与最近命令只在打开面板时读取一次，避免筛选时反复解析 localStorage
    const [usage, setUsage] = useState<PaletteUsageMap>({});
    const [recentCommands, setRecentCommands] = useState<string[]>([]);
    // 远端文件搜索结果（异步、带防抖），只在已连接的 SSH 会话下查询
    const [fileResults, setFileResults] = useState<SearchResultEntry[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const hasSession = !!activeSessionId;
    const hasSessions = sessions.length > 0;
    // 远端文件搜索依赖 SFTP 客户端：仅 SSH 会话可用
    const activeIsSsh = isSshKind(sessions.find((s) => s.id === activeSessionId)?.kind);
    // 会话从 connecting 变为 connected 时必须重新触发远端文件搜索：
    // 依赖里只有 activeSessionId 时，连接完成不会重跑 effect，
    // 用户必须再改一次关键字才能看到搜索结果。
    const activeSessionStatus = useSessionStore(
        (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status,
    );
    // 焦点是否落在当前布局内，以及布局还剩多少可拆分的窗格
    const paneInLayout = !!layout && !!activeSessionId && isPaneSession(layout, activeSessionId);
    const paneCount = layout ? countPanes(layout) : 0;
    const canSplitPane = (!layout || paneInLayout) && paneCount < MAX_PANES;

    // 全局快捷键：命令面板 + 分屏（捕获阶段注册，终端聚焦时同样生效）
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // 设置页正在录制快捷键时不响应，避免录制按键触发动作
            if (isShortcutRecording()) return;
            if (e.repeat) return;
            const combos = useUIStore.getState().shortcuts;

            // 其余全局动作在可编辑控件内不触发：否则在主机名、私钥、密码等输入框中
            // 按 Ctrl+Shift+D/E/U 会切分屏或开关草稿栏，并吞掉按键。
            // xterm 的隐藏 textarea 必须放行，否则终端内快捷键失效。
            const target = e.target instanceof HTMLElement ? e.target : null;
            const tag = target?.tagName.toLowerCase() ?? "";
            const editable = !!target && (tag === "input" || tag === "textarea" || target.isContentEditable);
            const xtermInput = !!target && target.classList.contains("xterm-helper-textarea");

            // Ctrl+K 作为命令面板的便捷别名，但只在终端外生效：
            // 终端里的 Ctrl+K 是 shell 的「删除到行尾」，不能抢占。
            const altPalette = !xtermInput
                && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
                && e.key.toLowerCase() === "k";
            if (matchesCombo(e, combos.palette) || altPalette) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(!useUIStore.getState().isCommandPaletteOpen);
                return;
            }

            if (editable && !xtermInput) return;

            if (matchesCombo(e, combos.splitRow)) {
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
        setUsage(loadPaletteUsage());
        // 最近命令跨端点合并：多台服务器上用过的命令都能出现在面板里
        const state = useSessionStore.getState();
        const active = state.sessions.find((s) => s.id === state.activeSessionId);
        setRecentCommands(
            active && active.kind !== "local" ? loadAllComposeHistory(8) : []
        );
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

    // 片段与最近命令都只填入命令行、不自动回车：命令参数是否需要调整由用户决定。
    // 与片段面板左键点击的行为保持一致，避免面板之间语义割裂。
    const insertIntoTab = (command: string, expandVariables: boolean) => {
        const state = useSessionStore.getState();
        const id = state.activeSessionId;
        if (!id) return;
        const session = state.sessions.find((s) => s.id === id);
        const text = expandVariables ? renderSnippetCommand(command, session) : command;
        // 显式带上会话类型：防止 store 中查不到会话时回落到 SSH 路由
        sendSessionInput(id, text.replace(/\r\n/g, "\n"), session?.kind).catch(console.error);
    };

    // 远端文件搜索：查询 ≥2 字符时递归搜索服务器文件系统，选中后跳转 SFTP 面板。
    // 本地终端没有 SFTP；会话未连接时后端也没有可用的 SFTP 客户端。
    useEffect(() => {
        const q = query.trim();
        setFileResults([]);
        if (!isOpen || !activeSessionId || !activeIsSsh || q.length < 2) return;
        if (activeSessionStatus !== "connected") return;

        let cancelled = false;
        const timer = setTimeout(() => {
            SftpService.SearchFiles(activeSessionId, "/", q, 20)
                .then((results) => {
                    if (!cancelled) setFileResults(results ?? []);
                })
                .catch(() => {
                    // 搜索失败不影响会话/命令条目：静默清空即可
                    if (!cancelled) setFileResults([]);
                });
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query, isOpen, activeSessionId, activeIsSsh, activeSessionStatus]);

    // 命令项随主机、片段、远端文件与当前会话状态变化重建
    const items = useMemo<PaletteItem[]>(() => {
        const list: PaletteItem[] = [];

        // 会话切换：分屏副窗格不在标签栏，也不进入列表，避免同名条目混淆
        sessions.filter((session) => !session.isSplitPane).forEach((session) => {
            const kind = session.kind ?? "ssh";
            const isLocal = kind === "local";
            // 不同来源展示各自的端点：SSH 用 user@host:port，Telnet 用 host:port，串口用设备名
            const hint = isLocal
                ? undefined
                : kind === "telnet"
                    ? `${session.netConn?.host ?? session.config.host}:${session.netConn?.port ?? session.config.port}`
                    : kind === "serial"
                        ? (session.netConn?.serial?.device ?? session.config.host)
                        : `${session.config.username}@${session.config.host}:${session.config.port}`;
            list.push({
                key: `session:${session.id}`,
                kind: "session",
                label: session.title,
                hint,
                icon: isLocal ? SquareTerminal : TerminalIcon,
                run: () => {
                    setActiveSession(session.id);
                    setOpen(false);
                },
            });
        });

        // 远端文件：文件跳转到父目录，目录直接进入；同时打开 SFTP 面板
        fileResults.forEach((entry) => {
            if (!activeSessionId) return;
            const dir = entry.isDir
                ? entry.path
                : entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
            list.push({
                key: `file:${entry.path}`,
                kind: "file",
                label: entry.name,
                hint: entry.path,
                icon: entry.isDir ? Folder : FileText,
                run: () => {
                    setFilePanelVisible(true);
                    requestSftpNavigate(activeSessionId, dir);
                    setOpen(false);
                },
            });
        });

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
                    insertIntoTab(snippet.command, true);
                    setOpen(false);
                },
            });
        });

        // 最近命令：来自命令草稿栏历史（按端点保存），只填入不执行
        recentCommands.forEach((command) => {
            const label = command.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
            if (!label) return;
            list.push({
                key: `command:${hashPaletteKey(command)}`,
                kind: "command",
                label,
                icon: Clock3,
                run: () => {
                    insertIntoTab(command, false);
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

        // 具体设置项直达：选中后切到设置页、滚动并短暂高亮对应行
        SETTINGS_ITEMS.forEach(({ target, category, labelKey }) => {
            const categoryLabel = SETTINGS_CATEGORIES.find((c) => c.id === category);
            list.push({
                key: `setting:${target}`,
                kind: "setting",
                label: t(labelKey, { ns: "settings" }),
                hint: categoryLabel ? t(categoryLabel.labelKey, { ns: "settings" }) : undefined,
                icon: SlidersHorizontal,
                run: () => {
                    openSettingsTarget(category, target);
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
            key: "action:quick-connect",
            kind: "action",
            label: t("palette_action_quick_connect"),
            icon: Zap,
            run: () => {
                setOpen(false);
                setQuickConnectOpen(true);
            },
        });

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

        // 文件面板与监控面板都依赖 SSH 的 SFTP 客户端 / 远端命令通道：
        // 本地、Telnet、串口会话没有这些能力，只在 SSH 会话下提供入口。
        if (hasSession && activeIsSsh) {
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
            list.push({
                key: "action:monitor-panel",
                kind: "action",
                label: t("palette_action_monitor"),
                hint: isMonitorPanelVisible ? t("palette_state_on") : t("palette_state_off"),
                icon: Gauge,
                run: () => {
                    toggleMonitorPanel();
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
            if (canSplitPane) {
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
            }
            if (paneInLayout) {
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
                key: "action:float",
                kind: "action",
                label: t("palette_action_float"),
                icon: AppWindow,
                run: () => {
                    const active = sessions.find((s) => s.id === activeSessionId);
                    if (active) void popOutSession(active);
                    setOpen(false);
                },
            });
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
    }, [hosts, keys, snippets, sessions, activeSessionId, hasSession, hasSessions, activeIsSsh, canSplitPane, paneInLayout, broadcastMode, isFilePanelVisible, isMonitorPanelVisible, shortcuts, recentCommands, fileResults, setFilePanelVisible, requestSftpNavigate, t]);

    const filtered = useMemo(() => {
        const q = query.trim();
        return items
            .map((item) => {
                const score = fuzzyScore(q, `${item.label} ${item.hint ?? ""}`);
                // 高频项加成封顶 80 分：只影响模糊命中之间的顺序，不会盖过直接子串命中
                const bonus = Math.min(usage[item.key] ?? 0, 40) * 2;
                return { item, score, total: score + bonus };
            })
            .filter((entry) => entry.score >= 0)
            // 先按分组顺序、再按匹配度/频次：保证键盘上下移动的顺序与视觉分组一致
            .sort((a, b) => {
                const rank = KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind);
                if (rank !== 0) return rank;
                if (b.total !== a.total) return b.total - a.total;
                return a.item.label.localeCompare(b.item.label);
            })
            .map((entry) => entry.item);
    }, [items, query, usage]);

    // 选中即计入使用频次（只存条目 key，不保存命令内容）
    const runItem = useCallback((item: PaletteItem) => {
        bumpPaletteUsage(item.key);
        item.run();
    }, []);

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
                const current = filtered[activeIndex];
                if (current) runItem(current);
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [isOpen, filtered, activeIndex, setOpen, runItem]);

    // 键盘移动时把选中项滚动到可视区域
    useEffect(() => {
        const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
        node?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const sectionTitle: Record<PaletteKind, string> = {
        session: t("palette_section_sessions"),
        file: t("palette_section_files"),
        host: t("palette_section_hosts"),
        snippet: t("palette_section_snippets"),
        command: t("palette_section_commands"),
        setting: t("palette_section_settings"),
        action: t("palette_section_actions"),
    };

    // 按固定顺序分组渲染，同时保留全局索引供键盘使用
    const sections = KIND_ORDER
        .map((kind) => ({ kind, items: filtered.filter((item) => item.kind === kind) }))
        .filter((section) => section.items.length > 0);

    return (
        <>
            {isOpen && (
                <div
                    className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-[4px]"
                    onClick={() => setOpen(false)}
                >
                    <div
                        className="palette-panel w-[min(620px,92vw)] overflow-hidden rounded-[var(--radius-xl)]
                                   border border-[var(--hairline-strong)] bg-[var(--surface-2)] shadow-[var(--shadow-modal)]"
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
                                    <div className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-[0.08em] text-[var(--fg-subtle)]">
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
                                                onClick={() => runItem(item)}
                                                className={cn(
                                                    "flex w-full items-center gap-3 px-4 py-2 text-left",
                                                    index === activeIndex
                                                        ? "bg-[var(--surface-3)] text-[var(--fg-strong)]"
                                                        : "text-[var(--fg-muted)]"
                                                )}
                                            >
                                                <Icon className="size-4 shrink-0 text-[var(--fg-subtle)]"/>
                                                <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
                                                {item.hint && (
                                                    <span className="max-w-[46%] shrink-0 truncate font-mono text-[11px] text-[var(--fg-subtle)]">
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
