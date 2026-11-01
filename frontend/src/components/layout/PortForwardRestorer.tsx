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

                if (beginRestoreAttempt(session.id, record.id) !== null) continue;

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
                        finishRestoreAttempt(session.id, record.id, true);
                        usePortForwardStore.getState().activateRestored(
                            record.id, session.id, title, scope, runtime,
                        );
                    })
                    .catch((err) => {
                        finishRestoreAttempt(session.id, record.id, false);
                        console.warn("恢复端口转发失败:", record, err);
                    });
            }
        }
    }, [sessions, forwards]);

    return null;
}
