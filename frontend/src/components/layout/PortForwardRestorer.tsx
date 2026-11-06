// 端口转发自动恢复：会话连上后，按宿主重建持久化保存的转发规则。
//
// 放在独立组件里而不是直接塞进 sessionStore，原因：
// 1. 恢复需要调用后端（异步）并在失败时保持"已停止"，属于界面层编排；
// 2. 组件随解锁状态挂载/卸载，锁屏后不会继续恢复。
// 恢复失败不弹全局提示：端口可能被本机其他程序占用，属于常见情况，
// 列表里保留"已停止"状态并提供删除入口即可。

import { useEffect } from "react";
import { PortForwardSpec } from "../../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { SshService } from "../../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useSessionStore } from "@/store/sessionStore";
import { usePortForwardStore } from "@/store/portForwardStore";
import {
    beginRestoreAttempt,
    finishRestoreAttempt,
    forwardScope,
    loadStoredForwards,
} from "@/lib/portForwardPersistence";

// 已发出但尚未拿到结果的恢复请求（按持久化配置 ID）。
// store 只有在 AddPortForward 成功后才出现 active 条目，从发起到落地之间
// 另一台同主机会话的 effect 仍会认为"未运行"，从而对同一本地端口再发一次请求，
// 第二次必然因端口占用失败。原生的 claimed 只能覆盖单次 effect 执行。
const inflightRestores = new Set<string>();

export function PortForwardRestorer() {
    const sessions = useSessionStore((s) => s.sessions);
    const forwards = usePortForwardStore((s) => s.forwards);

    useEffect(() => {
        const connected = sessions.filter((s) =>
            (s.kind ?? "ssh") === "ssh" && s.status === "connected" && !s.disconnected);
        if (connected.length === 0) return;

        // 分屏时同一主机的多个会话会同时连上：同一条持久化配置只能恢复一次，
        // 否则第二个请求必然因本地端口已被占用而失败，还会把这台会话标记为"恢复失败"
        const claimed = new Set<string>();

        for (const session of connected) {
            const scope = forwardScope(session);
            const stored = loadStoredForwards().filter((record) => record.scope === scope);
            if (stored.length === 0) continue;

            const title = session.title || session.config.host;
            for (const record of stored) {
                // 该配置已在某个会话上运行：同一本地端口不能再占用一次
                const running = forwards.some((item) =>
                    item.persistedId === record.id && item.status === "active");
                if (running) continue;
                if (claimed.has(record.id)) continue;
                claimed.add(record.id);

                // 先看是否有其他会话正在恢复同一配置：若有，本会话这次不算"已尝试"。
                // 反过来的顺序会给本会话写入永远不会被清除的 pending 记录
                // （finishRestoreAttempt 只由真正发起请求的会话调用），
                // 之后该会话即使重连也无法再恢复这条转发。
                if (inflightRestores.has(record.id)) continue;
                if (beginRestoreAttempt(session.id, record.id) !== null) continue;
                inflightRestores.add(record.id);

                // 记录发起恢复时的连接代次：请求在途期间用户可能点了重连，
                // 旧连接上的监听器会被 Disconnect 清理，但较慢的请求可能在
                // 新连接建立后才返回。此时若按"会话已连接"写回，列表会显示
                // 一个实际已失效的转发，且再也不会被重试。
                const restoreNonce = session.reconnectNonce ?? 0;

                const runtime = new PortForwardSpec({
                    id: crypto.randomUUID(),
                    sessionId: session.id,
                    type: record.type,
                    localHost: record.localHost,
                    localPort: record.localPort,
                    remoteHost: record.remoteHost,
                    remotePort: record.remotePort,
                });

                SshService.AddPortForward(runtime)
                    .then(() => {
                        // 请求在途时会话可能已被关闭/断开（后端监听器随之释放）：
                        // 此时写回 active 会在列表里留下没有会话承载的幽灵条目，
                        // 锁屏清空后还会被重新填回来。会话已不可用时直接丢弃，
                        // 也不记录失败状态——会话移除/重连时恢复记录已被清空，
                        // 这里再写入会让下次恢复被"已失败"挡住。
                        const current = useSessionStore.getState().sessions.find(
                            (s) => s.id === session.id
                        );
                        if (
                            !current
                            || current.status !== "connected"
                            || current.disconnected
                            || (current.reconnectNonce ?? 0) !== restoreNonce
                        ) {
                            return;
                        }
                        finishRestoreAttempt(session.id, record.id, true);
                        usePortForwardStore.getState().activateRestored(
                            record.id, session.id, title, scope, runtime,
                        );
                    })
                    .catch((err) => {
                        // 会话已被移除时不再写入失败记录：该会话的恢复记录
                        // 已随移除被清空，这里重建只会在模块级 Map 里留下
                        // 永远不会被读取的条目。
                        const stillExists = useSessionStore.getState().sessions
                            .some((s) => s.id === session.id);
                        if (stillExists) {
                            finishRestoreAttempt(session.id, record.id, false);
                        }
                        console.warn("恢复端口转发失败:", record, err);
                    })
                    .finally(() => {
                        inflightRestores.delete(record.id);
                    });
            }
        }
    }, [sessions, forwards]);

    return null;
}
