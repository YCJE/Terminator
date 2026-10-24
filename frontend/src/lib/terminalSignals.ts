// 终端信号解析：从字节流中提取 OSC 9 / OSC 777 桌面通知与 OSC 133 命令结束标记。
//
// 这些控制序列由远端程序或 shell 集成脚本输出，xterm.js 会忽略它们，
// 因此这里只做旁路解析，不修改写入终端的原始数据。
// 解析器只对 ESC ] 做线性扫描，未命中时不产生额外对象。

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const MAX_CARRY = 4096;

export interface TerminalSignalHandlers {
    /** OSC 9 / OSC 777 通知 */
    onNotify?: (title: string, body: string) => void;
    /** OSC 133;D 命令结束（$? 可解析时带回退出码） */
    onCommandDone?: (exitCode: number | null) => void;
}

/** 解析 `9;xxx` / `777;notify;title;body` 载荷 */
function handleOsc(code: number, payload: string, handlers: TerminalSignalHandlers): void {
    if (code === 9) {
        const text = payload.trim();
        if (text) handlers.onNotify?.("", text);
        return;
    }
    if (code === 777) {
        // 777;notify;title;body —— 非 notify 类型的 OSC 777 忽略
        const parts = payload.split(";");
        if (parts[0] === "notify") {
            const title = (parts[1] ?? "").trim();
            const body = parts.slice(2).join(";").trim();
            if (title || body) handlers.onNotify?.(title, body);
        }
        return;
    }
    if (code === 133) {
        // 133;D 表示命令执行结束；133;D;<exit code> 可选
        const parts = payload.split(";");
        if (parts[0] === "D") {
            const exitCode = parts[1] !== undefined ? Number.parseInt(parts[1], 10) : Number.NaN;
            handlers.onCommandDone?.(Number.isFinite(exitCode) ? exitCode : null);
        }
    }
}

export function createTerminalSignalParser(handlers: TerminalSignalHandlers) {
    let carry = new Uint8Array(0);

    const parse = (segment: Uint8Array): { consumed: number } => {
        // segment 以 ESC ] 开头；读取数字编号直到 ';' 或终止符
        let cursor = 2;
        let code = 0;
        while (cursor < segment.length) {
            const byte = segment[cursor];
            if (byte < 0x30 || byte > 0x39) break;
            code = code * 10 + (byte - 0x30);
            cursor++;
        }
        if (cursor >= segment.length) {
            // 编号还在下一块里，等待拼接后再判断
            return { consumed: -1 };
        }
        if (segment[cursor] !== 0x3b) {
            // 不是 "数字;" 形式的 OSC，直接跳过 ESC ] 继续扫描
            return { consumed: 2 };
        }
        cursor++; // 跳过 ';'

        let end = -1;
        let skip = 0;
        for (let i = cursor; i < segment.length; i++) {
            if (segment[i] === BEL) {
                end = i;
                skip = 1;
                break;
            }
            if (segment[i] === ESC && segment[i + 1] === BACKSLASH) {
                end = i;
                skip = 2;
                break;
            }
        }
        if (end < 0) {
            return { consumed: -1 }; // 序列未结束，等待下一块
        }

        let payload = "";
        for (let i = cursor; i < end; i++) payload += String.fromCharCode(segment[i]);
        handleOsc(code, payload, handlers);
        return { consumed: end + skip };
    };

    return (bytes: Uint8Array) => {
        if (bytes.length === 0) return;

        let data: Uint8Array;
        if (carry.length > 0) {
            data = new Uint8Array(carry.length + bytes.length);
            data.set(carry, 0);
            data.set(bytes, carry.length);
        } else {
            data = bytes;
        }

        let offset = 0;
        while (offset + 2 <= data.length) {
            let start = -1;
            for (let i = offset; i + 1 < data.length; i++) {
                if (data[i] === ESC && data[i + 1] === 0x5d) {
                    start = i;
                    break;
                }
            }
            if (start < 0) {
                // 只有末尾恰好是 ESC 时才需要保留一个字节等待 ']'，
                // 避免高频输出下每块都复制一段尾部数据
                carry = data[data.length - 1] === ESC
                    ? data.slice(data.length - 1)
                    : new Uint8Array(0);
                return;
            }

            const result = parse(data.subarray(start));
            if (result.consumed < 0) {
                const pending = data.slice(start);
                carry = pending.length > MAX_CARRY ? new Uint8Array(0) : pending;
                return;
            }
            offset = start + result.consumed;
        }

        carry = data.slice(offset);
    };
}
