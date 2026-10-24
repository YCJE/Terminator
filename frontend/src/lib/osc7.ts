/**
 * 从终端输出字节流中提取 OSC 7 目录上报（`ESC ] 7 ; file://host/path BEL|ST`）。
 *
 * 只做字节级扫描：高频输出（如 cat 大文件）下若先把整块数据解码成字符串，
 * 会产生大量临时对象。这里只在线性扫描中命中控制序列，未命中即返回。
 * 序列可能跨数据块，因此保留一个很小的尾部缓冲。
 */

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const MAX_CARRY = 512;

export function createOsc7Parser(onPath: (path: string) => void) {
    let carry = new Uint8Array(0);

    const parse = (segment: Uint8Array): { path: string; rest: number } | null => {
        // 前置条件：segment 以 ESC ] 7 ; 开头
        let end = -1;
        let skip = 0;
        for (let i = 4; i < segment.length; i++) {
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
        if (end < 0) return null;

        let uri = "";
        for (let i = 4; i < end; i++) uri += String.fromCharCode(segment[i]);
        // 只接受 file:// 形式的 URI；其他 scheme 忽略
        const prefix = uri.indexOf("://");
        if (prefix < 0) return { path: "", rest: end + skip };
        const slash = uri.indexOf("/", prefix + 3);
        if (slash < 0) return { path: "", rest: end + skip };

        let path = uri.slice(slash);
        try {
            path = decodeURIComponent(path);
        } catch {
            // 非法百分号编码时保留原样
        }
        return { path, rest: end + skip };
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
        while (offset + 4 < data.length) {
            // 查找 ESC ] 7 ;
            let start = -1;
            for (let i = offset; i + 3 < data.length; i++) {
                if (data[i] === ESC && data[i + 1] === 0x5d && data[i + 2] === 0x37 && data[i + 3] === 0x3b) {
                    start = i;
                    break;
                }
            }
            if (start < 0) {
                // 保留尾部，避免遗漏被截断的序列前缀
                const tailStart = Math.max(offset, data.length - MAX_CARRY);
                carry = data.slice(tailStart);
                return;
            }

            const result = parse(data.subarray(start));
            if (!result) {
                // 序列尚未结束：从 start 开始整体留到下一块。
                // 若迟迟等不到终止符（乱码或非 OSC 7 数据），丢弃超长缓冲避免无界增长。
                const pending = data.slice(start);
                carry = pending.length > MAX_CARRY ? new Uint8Array(0) : pending;
                return;
            }
            if (result.path) onPath(result.path);
            offset = start + result.rest;
        }

        carry = data.slice(Math.max(offset, data.length - MAX_CARRY));
    };
}
