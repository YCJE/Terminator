// 终端字符编码：后端按同一份白名单把 UTF-8 输入转成目标编码，
// 前端用 WHATWG TextDecoder 解码远端输出。只收录常见遗留编码，
// 避免出现"用户选了一个浏览器无法解码的值"这种半可用状态。

export interface TerminalEncodingOption {
    /** 存入主机配置的规范名 */
    value: string;
    /** 直接展示的编码名 */
    label: string;
}

export const TERMINAL_ENCODINGS: TerminalEncodingOption[] = [
    {value: "utf-8", label: "UTF-8"},
    {value: "gbk", label: "GBK"},
    {value: "gb18030", label: "GB18030"},
    {value: "big5", label: "Big5"},
    {value: "shift-jis", label: "Shift-JIS"},
    {value: "euc-jp", label: "EUC-JP"},
    {value: "koi8-r", label: "KOI8-R"},
    {value: "windows-1251", label: "Windows-1251"},
];

/** 把主机/会话里的编码值收敛到白名单中的规范名；未知值按 UTF-8 处理 */
export function normalizeTerminalEncoding(value?: string): string {
    const normalized = (value ?? "").trim().toLowerCase().replaceAll("_", "-");
    if (!normalized || normalized === "utf8" || normalized === "utf-8") return "utf-8";
    const found = TERMINAL_ENCODINGS.find((item) => item.value === normalized);
    return found?.value ?? "utf-8";
}

/**
 * 为非 UTF-8 编码创建流式解码器。
 * xterm.js 只按 UTF-8 解释字节，遗留编码必须先用 TextDecoder
 * 变成字符串再写入终端；stream 模式能正确处理跨数据包的半个字符。
 */
export function createTerminalDecoder(encoding?: string): TextDecoder | null {
    const normalized = normalizeTerminalEncoding(encoding);
    if (normalized === "utf-8") return null;
    try {
        return new TextDecoder(normalized, {fatal: false});
    } catch {
        // 运行环境不支持该编码时退回 UTF-8，会话仍可使用
        return null;
    }
}
