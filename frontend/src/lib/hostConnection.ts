import { Host, SavedKey } from "../../bindings/terminator-desktop/backend/internal/services/blob";
import { JumpHostConfig } from "../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { CreateSessionParams } from "@/store/sessionStore";

/** 无名主机的展示名回退规则。导出与导入必须使用同一规则，
 * 否则导入时 jumpHostName 匹配不到目标主机，跳板关联会被静默丢弃。 */
export function fallbackHostName(username: string, host: string): string {
    return `${username}@${host}`;
}

/**
 * 递归解析跳板机链：返回最外层跳板机配置，其 jumpHost 字段嵌套下一级跳板。
 * visited 记录已访问的 host id，避免 A→B→A 这类循环引用导致无限递归。
 */
export function resolveJumpHostChain(
    host: Host,
    hosts: Host[],
    keys: SavedKey[] | undefined,
    visited: Set<string> = new Set(),
): JumpHostConfig | undefined {
    if (!host.jumpHostId || visited.has(host.id)) return undefined;

    const jh = hosts.find((h) => h.id === host.jumpHostId);
    // 找不到、自引用或链上已出现过该跳板机时终止，避免死循环
    if (!jh || jh.id === host.id || visited.has(jh.id)) return undefined;

    // 只标记「当前主机」已访问，不能把 jh 一并标记：递归时 jh 会成为当前主机，
    // 提前标记会让它在下一层被当作"已访问"直接返回 undefined，
    // 从而把多级跳板链截断为仅第一层（配置了 A→B→C 实际只走 A→B）。
    visited.add(host.id);

    let jhKey: string | undefined = undefined;
    if (jh.keyId && keys) {
        const foundJhKey = keys.find((k) => k.id === jh.keyId);
        if (foundJhKey) jhKey = foundJhKey.privateKey;
    }

    return new JumpHostConfig({
        host: jh.host,
        port: jh.port,
        username: jh.username,
        password: jh.password || undefined,
        privateKey: jhKey,
        jumpHost: resolveJumpHostChain(jh, hosts, keys, visited),
    });
}

/** 把已保存的主机转换为建立 SSH 会话所需的参数（含跳板链、代理与认证）。 */
export function buildSessionParams(
    host: Host,
    hosts: Host[] | undefined,
    keys: SavedKey[] | undefined,
    password?: string,
): CreateSessionParams {
    let keyString: string | undefined = undefined;
    if (host.keyId && keys) {
        const foundKey = keys.find((k) => k.id === host.keyId);
        if (foundKey) keyString = foundKey.privateKey;
    }

    return {
        host: host.host,
        port: host.port,
        username: host.username,
        hostId: host.id,
        password: password || host.password,
        privateKey: keyString,
        title: host.name || host.host,
        jumpHost: hosts ? resolveJumpHostChain(host, hosts, keys) : undefined,
        proxyType: host.proxyType,
        proxyHost: host.proxyHost,
        proxyPort: host.proxyPort,
        proxyUsername: host.proxyUsername,
        proxyPassword: host.proxyPassword,
        agentForwarding: host.agentForwarding,
        onConnect: host.onConnect,
    };
}
