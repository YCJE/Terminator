import { create } from "zustand";
import { SSHConnectionConfig } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { JumpHostConfig } from "../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { SerialConfig } from "../../bindings/terminator-desktop/backend/internal/services/netconn";
import { Service as FloatingService } from "../../bindings/terminator-desktop/backend/internal/services/floating";
import { closeTransport } from "@/lib/sessionBackend";
import { SettingsService } from "../../bindings/terminator-desktop/backend/internal/services/settings";
import { useUIStore, ViewType } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";
import { clearScheduledTransfers } from "@/lib/transferScheduler";
import {
    MAX_PANES,
    buildPaneLayout,
    collectPaneSessionIds,
    countPaneShape,
    firstPaneSession,
    isPaneSession,
    makePaneLeaf,
    makePaneSplit,
    removePaneLeaf,
    replacePaneLeaf,
    setPaneNodeRatio,
    type PaneLayoutNode,
    type PaneShapeSnapshot,
} from "@/lib/paneLayout";
import { usePortForwardStore } from "@/store/portForwardStore";
import { resetRestoreAttempts } from "@/lib/portForwardPersistence";

export type SessionStatus = "connecting" | "connected" | "disconnected";

/** 会话来源：SSH 主机 / 本机 shell / Telnet / 串口 */
export type SessionKind = "ssh" | "local" | "telnet" | "serial";

/** Telnet 与串口的连接参数；SSH / 本地会话不使用 */
export interface NetConnConfig {
    /** Telnet 主机与端口 */
    host?: string;
    port?: number;
    /** 串口参数（设备名、波特率等） */
    serial?: SerialConfig;
    /** 远端字符编码（空值/utf-8 表示 UTF-8） */
    encoding?: string;
}

/** 分屏方向：row = 左右并排；column = 上下堆叠 */
export type SplitOrientation = "row" | "column";

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
    /** 会话来源：默认 ssh；local 表示本机 shell 终端 */
    kind?: SessionKind;
    /** Telnet / 串口连接参数（kind 为 telnet/serial 时必填） */
    netConn?: NetConnConfig;
    /** 来源主机 ID（用于工作区恢复；分屏副窗格沿用它） */
    hostId?: string;
    disconnected?: boolean;
    status: SessionStatus;
    /** 标签页自定义颜色（十六进制色值，如 '#ef4444'），未设置时为 undefined */
    color?: string;
    /** 分屏产生的副窗格：不出现在标签栏，随分屏创建与销毁 */
    isSplitPane?: boolean;
    /** 连接成功后自动执行并回车发送的命令（来自主机配置） */
    onConnect?: string;
    /** 终端最近一次上报的当前目录（OSC 7），用于 SFTP 跟随 */
    cwd?: string;
    /** 重连计数：递增以触发终端组件重新建立连接 */
    reconnectNonce?: number;
    /** 非激活标签期间产生了新输出（标签栏显示活动点） */
    hasActivity?: boolean;
    /** 收到命令结束标记（OSC 133;D），标签栏显示完成提示 */
    commandDone?: boolean;
    /** 用户手动重命名过标签：锁定标题，不再被 shell 上报的标题覆盖 */
    titleLocked?: boolean;
    /**
     * 附着到已存在的后端会话（浮动窗口收回时使用）：
     * 首次挂载不重建连接，终端只接管已有会话的输出。
     */
    attached?: boolean;
}

export interface CreateSessionParams {
    host: string;
    port: number;
    username: string;
    /** 来源主机 ID（可选），用于工作区恢复 */
    hostId?: string;
    password?: string;
    privateKey?: string;
    /** 加密私钥的解密口令（仅私钥带口令时使用） */
    privateKeyPassphrase?: string;
    /** 启用交互式认证（MFA/OTP）：服务器问答由前端弹窗填写 */
    keyboardInteractive?: boolean;
    /** OpenSSH 用户证书内容（*-cert.pub），与 privateKey 配对使用 */
    certificate?: string;
    title?: string;
    /** 跳板机配置（可选），通过中间主机跳转连接目标 */
    jumpHost?: JumpHostConfig;
    proxyType?: string;
    proxyHost?: string;
    proxyPort?: number;
    proxyUsername?: string;
    proxyPassword?: string;
    agentForwarding?: boolean;
    /** 连接成功后自动执行的命令（可选） */
    onConnect?: string;
    /** 请求 PTY 时上报的终端类型（留空使用 xterm-256color） */
    termType?: string;
    /** 建立连接的超时秒数（0 使用默认 15 秒） */
    connectTimeout?: number;
    /** 保活间隔秒数（0 使用默认 30 秒，负数关闭保活） */
    keepAlive?: number;
    /** 远端字符编码（空值/utf-8 表示 UTF-8） */
    encoding?: string;
}

// 判断已有会话与新建参数是否使用完全相同的连接路由（跳板机链 + 代理）与凭据。
// 仅比较 host/port/username 会把"经不同跳板机/代理到达同一目标"或"同一目标但
// 使用不同密码/私钥/Agent 转发设置"的连接误判为重复会话，导致第二次连接静默
// 复用错误链路或错误凭据，用户以为连上了新会话实际用的是旧会话的认证信息。
function sameRoute(config: SSHConnectionConfig, params: CreateSessionParams): boolean {
    let a = config.jumpHost ?? null;
    let b = params.jumpHost ?? null;
    while (a && b) {
        if (a.host !== b.host || a.port !== b.port || a.username !== b.username) return false;
        a = a.jumpHost ?? null;
        b = b.jumpHost ?? null;
    }
    if (a || b) return false;
    const str = (v?: string) => v ?? "";
    const port = (v?: number) => v ?? 0;
    return (
        str(config.proxyType) === str(params.proxyType) &&
        str(config.proxyHost) === str(params.proxyHost) &&
        port(config.proxyPort) === port(params.proxyPort) &&
        str(config.proxyUsername) === str(params.proxyUsername) &&
        str(config.proxyPassword) === str(params.proxyPassword) &&
        str(config.password) === str(params.password) &&
        str(config.privateKey) === str(params.privateKey) &&
        str(config.privateKeyPassphrase) === str(params.privateKeyPassphrase) &&
        str(config.certificate) === str(params.certificate) &&
        (config.keyboardInteractive ?? false) === (params.keyboardInteractive ?? false) &&
        (config.agentForwarding ?? false) === (params.agentForwarding ?? false) &&
        // 终端类型/编码会影响显示与输入转码：不同设置不能复用同一会话
        str(config.termType) === str(params.termType) &&
        str(config.encoding) === str(params.encoding) &&
        port(config.connectTimeout) === port(params.connectTimeout) &&
        port(config.keepAlive) === port(params.keepAlive)
    );
}

/** 按会话来源关闭底层传输：本地 shell / SSH / Telnet / 串口分别路由。 */
function closeSessionTransport(session: TerminalSession | undefined): void {
    if (!session) return;
    closeTransport(session.kind, session.id).catch(console.error);
}

/**
 * 已移入浮动窗口的会话 ID。
 *
 * removeSession(keepConnection) 只移除标签视图，后端连接由浮动窗口继续持有；
 * 终端组件卸载时的清理逻辑必须跳过这些会话，否则连接会被视图卸载顺手关掉，
 * 浮动窗口里只剩一个"已连接"但没有任何输出的空终端。
 * 会话收回标签栏或清空全部会话时移除标记。
 */
const detachedSessionIds = new Set<string>();

/** 该会话是否已交给浮动窗口（卸载视图时不能关闭其后端连接） */
export function isSessionDetached(sessionId: string): boolean {
    return detachedSessionIds.has(sessionId);
}

interface SessionState {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    /** 广播模式：开启后在一个终端输入会同时发送到所有活跃终端 */
    broadcastMode: boolean;
    /** 广播排除列表：按会话单独退出广播，避免误操作生产机 */
    broadcastExcluded: string[];
    /** 切换单个会话是否参与广播 */
    toggleBroadcastSession: (id: string) => void;
    /**
     * 当前窗格布局（最多 4 个窗格）。null 表示未分屏。
     * 布局中的第一个叶子是对应标签页的主会话，其余叶子标记为 isSplitPane。
     */
    layout: PaneLayoutNode | null;
    /** 调整某个分屏节点的比例（拖动分隔条时调用） */
    setPaneRatio: (nodeId: string, ratio: number) => void;
    /** 按快照形状恢复多窗格布局：rootSessionId 必须是已存在的普通会话 */
    restorePaneLayout: (rootSessionId: string, shape: PaneShapeSnapshot) => void;
    addSession: (params: CreateSessionParams) => void;
    /** 新建本地 shell 终端标签 */
    addLocalSession: (title?: string) => void;
    /** 新建 Telnet 或串口会话标签 */
    addNetConnSession: (params: {
        kind: "telnet" | "serial";
        /** Telnet 主机 */
        host?: string;
        port?: number;
        /** 串口参数 */
        serial?: SerialConfig;
        /** 远端字符编码（空值/utf-8 表示 UTF-8） */
        encoding?: string;
        title?: string;
    }) => void;
    /**
     * 关闭标签/窗格。
     * keepConnection=true 时只移除视图、保留后端连接（会话移入浮动窗口）。
     */
    removeSession: (id: string, options?: { keepConnection?: boolean }) => void;
    /** 把浮动窗口中仍在运行的会话挂回标签栏（不重建连接） */
    adoptSession: (params: {
        sessionId: string;
        title: string;
        kind: SessionKind;
        config: SSHConnectionConfig;
        /** 来源主机 ID：浮动窗口收回时原样带回，工作区/书签等按主机归属 */
        hostId?: string;
        /** Telnet / 串口连接参数 */
        netConn?: NetConnConfig;
        /** false 表示后端会话已断开，挂回后需要重新连接 */
        attached?: boolean;
    }) => void;
    setActiveSession: (id: string) => void;
    /** 非激活标签产生的输出：点亮活动指示点 */
    markSessionActivity: (id: string) => void;
    /** 收到命令结束标记：点亮完成指示点 */
    markSessionDone: (id: string) => void;
    markSessionDisconnected: (id: string) => void;
    setSessionStatus: (id: string, status: SessionStatus) => void;
    setSessionColor: (id: string, color: string) => void;
    /** 重命名标签页（空白标题会被忽略） */
    renameSession: (id: string, title: string) => void;
    /** 跟随 shell 上报的标题（OSC 0/2）：手动重命名过的标签会被锁定，不再自动覆盖 */
    setSessionTermTitle: (id: string, title: string) => void;
    /** 复制会话：按相同连接参数新建一个标签，排在源标签之后 */
    duplicateSession: (id: string) => void;
    /** 关闭除指定标签外的其他普通标签 */
    closeOtherSessions: (id: string) => void;
    /** 关闭指定标签右侧的所有普通标签 */
    closeSessionsToRight: (id: string) => void;
    /** 记录终端上报的当前目录（OSC 7） */
    setSessionCwd: (id: string, cwd: string) => void;
    /** 重连会话：复位断开状态并触发终端组件重新连接 */
    reconnectSession: (id: string) => void;
    /** 按会话 ID 重排标签（拆分屏后标签栏过滤了副窗格，索引不再与完整数组对应） */
    reorderSessionsByIds: (fromId: string, toId: string) => void;
    /** 切换到相邻普通标签（direction=1 下一个，-1 上一个，循环） */
    activateAdjacentSession: (id: string, direction: 1 | -1) => void;
    clearSessions: () => void;
    toggleBroadcastMode: () => void;
    /** 直接设置广播模式开关 */
    setBroadcastMode: (enabled: boolean) => void;
    /** 获取所有活跃（已连接）的会话 ID */
    getActiveSessionIds: () => string[];
    /** 将当前会话一分为二（新建一个同配置会话作为副窗格） */
    splitActiveSession: (orientation: SplitOrientation) => void;
    /** 关闭分屏，保留主窗格 */
    closeSplit: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,
    broadcastMode: false,
    broadcastExcluded: [],
    layout: null,

    addSession: (params) => {
        const state = get();

        // 记录最近连接：只在本地落盘（不参与同步），失败不影响连接流程
        if (params.hostId) {
            SettingsService.RecordHostUsed(params.hostId).catch(() => {});
        }

        // 检查是否已有相同主机+端口+用户名且连接路由一致的活跃会话
        const existing = state.sessions.find(
            (s) =>
                s.config.host === params.host &&
                s.config.port === params.port &&
                s.config.username === params.username &&
                !s.disconnected &&
                sameRoute(s.config, params)
        );

        if (existing) {
            useUIStore.getState().setActiveView(ViewType.Terminal);
            set({ activeSessionId: existing.id });
            return;
        }

        const newId = crypto.randomUUID();

        const fullConfig = new SSHConnectionConfig({
            id: newId,
            host: params.host,
            port: params.port,
            username: params.username,
            password: params.password,
            privateKey: params.privateKey,
            privateKeyPassphrase: params.privateKeyPassphrase,
            keyboardInteractive: params.keyboardInteractive,
            certificate: params.certificate,
            jumpHost: params.jumpHost,
            proxyType: params.proxyType,
            proxyHost: params.proxyHost,
            proxyPort: params.proxyPort,
            proxyUsername: params.proxyUsername,
            proxyPassword: params.proxyPassword,
            agentForwarding: params.agentForwarding,
            termType: params.termType,
            connectTimeout: params.connectTimeout,
            keepAlive: params.keepAlive,
            encoding: params.encoding,
        });

        const newSession: TerminalSession = {
            id: newId,
            title: params.title || params.host,
            config: fullConfig,
            hostId: params.hostId,
            status: "connecting",
            onConnect: params.onConnect?.trim() || undefined,
        };

        useUIStore.getState().setActiveView(ViewType.Terminal);

        set({
            sessions: [...state.sessions, newSession],
            activeSessionId: newId,
        });
    },

    addLocalSession: (title) => {
        const id = crypto.randomUUID();
        // 本地会话不涉及远端凭据，config 只用于复用终端组件的字段结构
        const config = new SSHConnectionConfig({
            id,
            host: "local",
            port: 0,
            username: "",
        });
        const session: TerminalSession = {
            id,
            title: title || "本地终端",
            config,
            kind: "local",
            status: "connecting",
        };
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set((state) => ({
            sessions: [...state.sessions, session],
            activeSessionId: id,
        }));
    },

    addNetConnSession: ({kind, host, port, serial, encoding, title}) => {
        const id = crypto.randomUUID();
        const isTelnet = kind === "telnet";
        const cleanHost = isTelnet ? (host ?? "").trim() : "";
        const cleanPort = isTelnet ? Number(port ?? 23) : 0;
        // config 只用于复用终端组件的字段结构与状态栏展示，不参与 SSH 连接
        const config = new SSHConnectionConfig({
            id,
            host: isTelnet ? cleanHost : (serial?.device ?? ""),
            port: cleanPort,
            username: "",
        });
        const fallbackTitle = isTelnet
            ? `${cleanHost}:${cleanPort}`
            : (serial?.device ?? "");
        const session: TerminalSession = {
            id,
            title: title?.trim() || fallbackTitle,
            config,
            kind,
            netConn: isTelnet
                ? {host: cleanHost, port: cleanPort, encoding}
                : {serial, encoding},
            status: "connecting",
        };
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set((state) => ({
            sessions: [...state.sessions, session],
            activeSessionId: id,
        }));
    },

    adoptSession: ({sessionId, title, kind, config, hostId, netConn, attached = true}) => {
        // 会话已收回标签栏：所有权重新归主窗口，后续卸载可以正常关闭连接
        detachedSessionIds.delete(sessionId);
        const state = get();
        if (state.sessions.some((s) => s.id === sessionId)) {
            useUIStore.getState().setActiveView(ViewType.Terminal);
            set({activeSessionId: sessionId});
            return;
        }
        const session: TerminalSession = {
            id: sessionId,
            title: title || config.host,
            config,
            kind,
            hostId: hostId || undefined,
            netConn,
            // 后端连接仍在运行时直接标记为已连接，终端以附着模式挂载；
            // 会话已断开时保持 connecting，由终端组件重新建立连接
            status: attached ? "connected" : "connecting",
            attached,
        };
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({
            sessions: [...state.sessions, session],
            activeSessionId: sessionId,
        });
    },

    removeSession: (id, options) => {
        // 会话移入浮动窗口时只移除视图：后端连接、传输与端口转发都必须继续运行，
        // 对应的队列条目也保留，窗口关闭导致连接断开时再统一标记为已停止。
        if (!options?.keepConnection) {
            closeSessionTransport(get().sessions.find((s) => s.id === id));
            // 清理关联的传输任务，避免孤儿数据
            useTransferStore.getState().removeTransfersBySession(id);
            clearScheduledTransfers(id);
            // 后端 Disconnect 已关闭该会话的全部监听器：条目转为"已停止"，
            // 持久化配置保留，下次连接同一主机时由 PortForwardRestorer 自动重建
            usePortForwardStore.getState().markStoppedBySession(id);
            resetRestoreAttempts(id);
        } else {
            // 只移除了视图，连接仍在浮动窗口中运行：卸载清理必须跳过断开
            detachedSessionIds.add(id);
        }

        const state = get();
        let sessions = state.sessions;
        let activeSessionId = state.activeSessionId;
        let nextLayout = state.layout;
        // 布局坍缩到单窗格时，幸存的会话要提升为普通标签
        let promotedSessionId: string | null = null;

        if (state.layout && isPaneSession(state.layout, id)) {
            const result = removePaneLeaf(state.layout, id);
            if (result.node && result.node.kind === "leaf") {
                promotedSessionId = result.node.sessionId;
                nextLayout = null;
            } else {
                nextLayout = result.node;
            }
            const newRoot = promotedSessionId
                ?? (nextLayout ? firstPaneSession(nextLayout) : null);
            if (newRoot) {
                sessions = sessions.map((s) =>
                    s.id === newRoot ? {...s, isSplitPane: false} : s
                );
            }
        }

        const newSessions = sessions.filter((s) => s.id !== id);
        let shouldGoToHosts = false;

        if (activeSessionId === id) {
            // 布局仍有窗格时优先聚焦新的标签代表；全部窗格关闭后回退到相邻标签
            const paneTarget = promotedSessionId
                ?? (nextLayout ? firstPaneSession(nextLayout) : null);
            if (paneTarget) {
                activeSessionId = paneTarget;
            } else {
                // 回退到前一个普通标签；分屏副窗格不参与标签切换
                const normalSessions = newSessions.filter((s) => !s.isSplitPane);
                if (normalSessions.length > 0) {
                    const closedIndex = state.sessions.findIndex((s) => s.id === id);
                    activeSessionId = (normalSessions.filter(
                        (s) => state.sessions.findIndex((x) => x.id === s.id) < closedIndex
                    ).pop() || normalSessions[0]).id;
                } else {
                    activeSessionId = null;
                    shouldGoToHosts = true;
                }
            }
        }

        set({
            sessions: newSessions,
            activeSessionId,
            layout: nextLayout,
            broadcastExcluded: state.broadcastExcluded.filter((x) => x !== id),
        });

        // 在 set 之外触发其他 store 的状态变更，避免更新顺序不确定
        if (shouldGoToHosts) {
            useUIStore.getState().setActiveView(ViewType.Hosts);
            useUIStore.getState().setFilePanelVisible(false);
        }
    },

    markSessionDisconnected: (id) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id ? { ...s, disconnected: true, status: "disconnected" as const } : s
            ),
        }));
        // 会话断开时后端已关闭其全部端口转发监听器，同步标记前端列表；
        // 清空恢复尝试记录，使重连后仍会重新尝试自动恢复
        usePortForwardStore.getState().markStoppedBySession(id);
        resetRestoreAttempts(id);
    },

    setSessionStatus: (id, status) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id ? { ...s, status, disconnected: status === "disconnected" } : s
            ),
        }));
    },

    setSessionColor: (id, color) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                // 传空字符串时清除颜色（设为 undefined）
                s.id === id ? { ...s, color: color || undefined } : s
            ),
        }));
    },

    renameSession: (id, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        set((state) => ({
            sessions: state.sessions.map((s) =>
                // 手动改名后锁定标题：之后 shell 再上报 OSC 标题也不覆盖
                s.id === id ? {...s, title: trimmed, titleLocked: true} : s
            ),
        }));
    },

    setSessionTermTitle: (id, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id && !s.titleLocked && s.title !== trimmed
                    ? {...s, title: trimmed}
                    : s
            ),
        }));
    },

    duplicateSession: (id) => {
        const state = get();
        const source = state.sessions.find((s) => s.id === id);
        // 分屏副窗格不出现在标签栏，没有"复制会话"的入口
        if (!source || source.isSplitPane) return;

        const newId = crypto.randomUUID();
        // 复用完整连接参数（跳板链、代理、凭据），只替换会话 ID
        const config = new SSHConnectionConfig({...source.config, id: newId});
        const copy: TerminalSession = {
            id: newId,
            title: source.title,
            config,
            kind: source.kind,
            netConn: source.netConn,
            hostId: source.hostId,
            status: "connecting",
            onConnect: source.onConnect,
            color: source.color,
        };

        const sessions = [...state.sessions];
        const index = sessions.findIndex((s) => s.id === id);
        sessions.splice(index + 1, 0, copy);
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({sessions, activeSessionId: newId});
    },

    closeOtherSessions: (id) => {
        // 逐步取最新状态：关闭分屏主窗格会把副窗格提升为普通标签，
        // 一次性快照会漏掉被提升的标签，导致"关闭其他"后仍残留标签。
        for (let guard = 0; guard < 200; guard++) {
            const state = get();
            const victim = state.sessions.find((s) => !s.isSplitPane && s.id !== id);
            if (!victim) break;
            get().removeSession(victim.id);
        }
        if (get().sessions.some((s) => s.id === id)) {
            get().setActiveSession(id);
        }
    },

    closeSessionsToRight: (id) => {
        for (let guard = 0; guard < 200; guard++) {
            const tabs = get().sessions.filter((s) => !s.isSplitPane);
            const index = tabs.findIndex((s) => s.id === id);
            if (index < 0 || index >= tabs.length - 1) break;
            get().removeSession(tabs[index + 1].id);
        }
        if (get().sessions.some((s) => s.id === id)) {
            get().setActiveSession(id);
        }
    },

    setSessionCwd: (id, cwd) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id && s.cwd !== cwd ? { ...s, cwd } : s
            ),
        }));
    },

    reconnectSession: (id) => {
        // 重连会先关闭旧连接，后端随之释放该会话的全部端口转发监听器。
        // 只把状态改成 connecting 会让列表里的条目继续显示"运行中"，
        // PortForwardRestorer 又因 active 条目跳过重建，重连成功后这些转发
        // 永远无法恢复；同时清空失败记录，让恢复逻辑重新尝试。
        usePortForwardStore.getState().markStoppedBySession(id);
        resetRestoreAttempts(id);
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id
                    ? {
                        ...s,
                        status: "connecting" as const,
                        disconnected: false,
                        // 新连接从用户主目录开始：清掉旧会话的目录与活动标记，
                        // 否则文件面板会在 connected 后按旧 cwd 导航（与实际不符），
                        // 标签也会残留"有新输出/命令完成"指示点。
                        cwd: undefined,
                        hasActivity: false,
                        commandDone: false,
                        reconnectNonce: (s.reconnectNonce ?? 0) + 1,
                    }
                    : s
            ),
        }));
    },

    reorderSessionsByIds: (fromId, toId) => {
        set((state) => {
            // 拖拽使用会话 ID 而非数组下标：分屏副窗格不出现在标签栏，
            // 标签下标与 sessions 数组下标不一致，按下标替换会移动错误的标签。
            const fromIndex = state.sessions.findIndex((s) => s.id === fromId);
            const toIndex = state.sessions.findIndex((s) => s.id === toId);
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
                return {};
            }
            const sessions = [...state.sessions];
            const [moved] = sessions.splice(fromIndex, 1);
            sessions.splice(toIndex, 0, moved);
            return { sessions };
        });
    },

    activateAdjacentSession: (id, direction) => {
        const state = get();
        const tabs = state.sessions.filter((s) => !s.isSplitPane);
        if (tabs.length === 0) return;
        // 布局内任一窗格都映射到标签代表会话，再计算相邻标签
        const baseId = state.layout && isPaneSession(state.layout, id)
            ? firstPaneSession(state.layout) ?? id
            : id;
        const index = tabs.findIndex((s) => s.id === baseId);
        const nextIndex = index < 0
            ? 0
            : (index + direction + tabs.length) % tabs.length;
        get().setActiveSession(tabs[nextIndex].id);
    },

    markSessionActivity: (id) => {
        // 正在查看的标签无需活动提示（避免每块输出都触发一次状态比较）
        if (get().activeSessionId === id) return;
        set((state) => {
            const target = state.sessions.find((s) => s.id === id);
            if (!target || target.hasActivity) return {};
            return {
                sessions: state.sessions.map((s) => (s.id === id ? {...s, hasActivity: true} : s)),
            };
        });
    },

    markSessionDone: (id) => {
        set((state) => {
            const target = state.sessions.find((s) => s.id === id);
            if (!target || target.commandDone) return {};
            return {
                sessions: state.sessions.map((s) => (s.id === id ? {...s, commandDone: true} : s)),
            };
        });
    },

    setActiveSession: (id) => {
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set((state) => {
            const needsClear = state.sessions.some(
                (s) => s.id === id && (s.hasActivity || s.commandDone)
            );
            if (!needsClear) return {activeSessionId: id};
            return {
                activeSessionId: id,
                sessions: state.sessions.map((s) =>
                    s.id === id ? {...s, hasActivity: false, commandDone: false} : s
                ),
            };
        });
    },

    clearSessions: () => {
        // 浮动窗口中的会话不在标签列表里，必须一并关闭窗口（其关闭钩子会断开连接）
        FloatingService.CloseAllFloatingWindows().catch(console.error);
        const {sessions} = get();
        sessions.forEach((session) => {
            closeSessionTransport(session);
            // 调度器是模块级队列，不随组件卸载清空：不在这里移除，
            // 上一批会话排队中的传输会在新界面里继续执行（并写入已关闭的会话）
            clearScheduledTransfers(session.id);
            // 清掉该会话的端口转发恢复记录：会话 ID 不会复用，
            // 不清理会让模块级 Map 随每次锁屏/擦除持续增长
            resetRestoreAttempts(session.id);
        });

        // 清空所有传输任务
        useTransferStore.getState().clearAll();
        // 所有会话均已断开，端口转发条目一并清空
        usePortForwardStore.getState().clearAll();
        useUIStore.getState().setActiveView(ViewType.Hosts);
        useUIStore.getState().setFilePanelVisible(false);
        // 锁屏/擦除/导入备份会卸载并重建整个界面，但这几个开关存在 store 里：
        // 不复位的话解锁后命令面板会"自己弹出来"，快速连接对话框也会重新打开。
        useUIStore.getState().setCommandPaletteOpen(false);
        useUIStore.getState().setQuickConnectOpen(false);
        // 浮动窗口已全部关闭，它们的会话所有权标记也就没有意义了
        detachedSessionIds.clear();
        // 广播模式必须一起复位：锁屏/擦除/恢复备份后是新一批会话，
        // 沿用旧的广播开关会把输入静默发往用户没有预期的主机。
        set({
            sessions: [],
            activeSessionId: null,
            layout: null,
            broadcastMode: false,
            broadcastExcluded: [],
        });
    },

    toggleBroadcastMode: () => {
        set((state) => ({broadcastMode: !state.broadcastMode}));
    },

    setBroadcastMode: (enabled: boolean) => {
        set({broadcastMode: enabled});
    },

    toggleBroadcastSession: (id) => {
        set((state) => ({
            broadcastExcluded: state.broadcastExcluded.includes(id)
                ? state.broadcastExcluded.filter((x) => x !== id)
                : [...state.broadcastExcluded, id],
        }));
    },

    getActiveSessionIds: () => {
        return get().sessions
            .filter((s) => s.status === "connected" && !s.disconnected)
            .map((s) => s.id);
    },

    setPaneRatio: (nodeId, ratio) => {
        set((state) => {
            if (!state.layout) return {};
            return {layout: setPaneNodeRatio(state.layout, nodeId, ratio)};
        });
    },

    restorePaneLayout: (rootSessionId, shape) => {
        const state = get();
        const root = state.sessions.find((s) => s.id === rootSessionId);
        if (!root || !shape) return;
        // 同一时刻只维护一组分屏：已有布局时不能直接覆盖，否则旧布局里的
        // 窗格会话会从渲染树中消失（既不在布局里，也不是当前标签），
        // 但连接仍在后台运行，用户再也无法看到或关闭它们。
        // 快照/工作区恢复因此退化为"只恢复标签"；关闭现有分屏后可再次打开快照。
        if (state.layout) return;
        const panes = countPaneShape(shape);
        if (panes < 2 || panes > MAX_PANES) return;

        const ids = [rootSessionId];
        const extras: TerminalSession[] = [];
        for (let index = 1; index < panes; index++) {
            const newId = crypto.randomUUID();
            ids.push(newId);
            extras.push({
                id: newId,
                title: root.title,
                config: new SSHConnectionConfig({...root.config, id: newId}),
                kind: root.kind,
                netConn: root.netConn,
                hostId: root.hostId,
                status: "connecting",
                isSplitPane: true,
                onConnect: root.onConnect,
            });
        }
        const layout = buildPaneLayout(shape, ids);
        if (!layout) return;
        set({
            sessions: [...state.sessions, ...extras],
            layout,
            activeSessionId: rootSessionId,
        });
        useUIStore.getState().setActiveView(ViewType.Terminal);
    },

    splitActiveSession: (orientation) => {
        const state = get();
        const active = state.sessions.find((s) => s.id === state.activeSessionId);
        if (!active || active.disconnected) return;
        // 已有布局时只允许从布局内的窗格继续拆分；切到其他标签时不串组
        if (state.layout && !isPaneSession(state.layout, active.id)) return;
        const panes = state.layout ? collectPaneSessionIds(state.layout).length : 1;
        if (panes >= MAX_PANES) return;

        const newId = crypto.randomUUID();
        // 复用当前窗格的完整连接参数（含跳板链、代理与凭据），仅替换会话 ID
        const config = new SSHConnectionConfig({...active.config, id: newId});
        const secondary: TerminalSession = {
            id: newId,
            title: active.title,
            config,
            kind: active.kind,
            netConn: active.netConn,
            hostId: active.hostId,
            status: "connecting",
            isSplitPane: true,
            onConnect: active.onConnect,
        };

        let layout: PaneLayoutNode;
        if (!state.layout) {
            layout = makePaneSplit(orientation, makePaneLeaf(active.id), makePaneLeaf(newId));
        } else {
            const result = replacePaneLeaf(state.layout, active.id, (leaf) =>
                makePaneSplit(orientation, leaf, makePaneLeaf(newId))
            );
            if (!result.replaced) return;
            layout = result.node;
        }

        set({
            sessions: [...state.sessions, secondary],
            layout,
            activeSessionId: newId,
        });
        // 从设置页等非终端视图触发时，切回终端以展示新窗格
        useUIStore.getState().setActiveView(ViewType.Terminal);
    },

    closeSplit: () => {
        const state = get();
        const layout = state.layout;
        if (!layout) return;
        const rootId = firstPaneSession(layout);
        const ids = collectPaneSessionIds(layout);
        if (!rootId) return;

        // 关闭除标签代表外的全部窗格：与旧版"取消分屏保留主窗格"一致
        for (const id of ids) {
            if (id === rootId) continue;
            closeSessionTransport(state.sessions.find((s) => s.id === id));
            useTransferStore.getState().removeTransfersBySession(id);
            clearScheduledTransfers(id);
            usePortForwardStore.getState().markStoppedBySession(id);
            resetRestoreAttempts(id);
        }
        const sessions = state.sessions
            .filter((s) => s.id === rootId || !ids.includes(s.id))
            .map((s) => (s.id === rootId ? {...s, isSplitPane: false} : s));
        set({
            sessions,
            layout: null,
            activeSessionId: state.activeSessionId
                && ids.includes(state.activeSessionId)
                && state.activeSessionId !== rootId
                ? rootId
                : state.activeSessionId,
        });
    }
}));
