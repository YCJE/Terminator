// 终端关键词高亮工具
//
// 设计思路：
// 拦截 SSH 输出的字节数据，解码为文本后识别关键词，
// 用 ANSI 颜色转义序列包裹关键词，使其在终端中以彩色显示。
//
// 使用 TextDecoder 的 stream 模式处理 UTF-8 多字节字符跨包拆分问题：
// TextDecoder 会缓存不完整的尾部字节，在下次 decode() 时拼接，避免乱码。
//
// 注意：此方案为"简单方案"，存在以下已知限制：
// 1. 关键词若被拆分到两个数据包中（罕见），可能不会被高亮
// 2. 已有 ANSI 颜色的文本中的关键词被重新着色后会清除原有颜色
// 3. 写入路径从 Uint8Array 改为 string，有微小的性能开销

/** 关键词规则：文本 + 对应的 ANSI SGR 颜色序列 */
export interface KeywordRule {
    /** 关键词文本 */
    text: string;
    /** ANSI SGR 转义序列，如 '\x1b[1;91m' 表示粗体亮红色 */
    color: string;
}

/** ANSI 重置序列，清除所有文本属性 */
const ANSI_RESET = '\x1b[0m';

/**
 * 默认关键词高亮规则
 *
 * 颜色使用 SGR（Select Graphic Rendition）序列：
 * - 1;91 = 粗体亮红色（ERROR / FAIL）
 * - 1;93 = 粗体亮黄色（WARN / WARNING）
 * - 1;96 = 粗体亮青色（INFO）
 * - 1;92 = 粗体亮绿色（success）
 */
export const DEFAULT_KEYWORDS: KeywordRule[] = [
    // 错误类 → 红色
    { text: 'ERROR', color: '\x1b[1;91m' },
    { text: 'Error', color: '\x1b[1;91m' },
    { text: 'error', color: '\x1b[1;91m' },
    { text: 'FAIL', color: '\x1b[1;91m' },
    { text: 'Fail', color: '\x1b[1;91m' },
    { text: 'fail', color: '\x1b[1;91m' },
    { text: 'Failed', color: '\x1b[1;91m' },
    { text: 'failed', color: '\x1b[1;91m' },
    // 警告类 → 黄色
    { text: 'WARN', color: '\x1b[1;93m' },
    { text: 'WARNING', color: '\x1b[1;93m' },
    { text: 'Warn', color: '\x1b[1;93m' },
    { text: 'warn', color: '\x1b[1;93m' },
    { text: 'warning', color: '\x1b[1;93m' },
    // 信息类 → 青色
    { text: 'INFO', color: '\x1b[1;96m' },
    { text: 'Info', color: '\x1b[1;96m' },
    { text: 'info', color: '\x1b[1;96m' },
    // 成功类 → 绿色
    { text: 'SUCCESS', color: '\x1b[1;92m' },
    { text: 'Success', color: '\x1b[1;92m' },
    { text: 'success', color: '\x1b[1;92m' },
];

/**
 * 转义字符串中的正则表达式特殊字符
 * 防止关键词中的特殊字符被当作正则语法解析
 */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 创建关键词高亮处理器
 *
 * 处理器内部维护一个 TextDecoder 实例（stream 模式），
 * 用于正确处理跨数据包的 UTF-8 多字节字符。
 *
 * @param keywords 关键词规则列表，默认使用 DEFAULT_KEYWORDS
 * @returns 处理器对象，包含 process 和 flush 方法
 */
export function createKeywordHighlighter(keywords: KeywordRule[] = DEFAULT_KEYWORDS) {
    // 按关键词文本长度降序排列，确保 "WARNING" 优先于 "WARN" 匹配
    // 虽然单词边界 \b 已能处理此问题，但长词优先是更稳健的做法
    const sorted = [...keywords].sort((a, b) => b.text.length - a.text.length);

    // 构建匹配所有关键词的正则表达式，使用单词边界 \b 避免子串误匹配
    // 例如：\bfail\b 不会匹配 "failed" 中的 "fail"
    const pattern = new RegExp(
        `\\b(${sorted.map((k) => escapeRegExp(k.text)).join('|')})\\b`,
        'g',
    );

    // 构建 关键词 → 颜色 的映射表，用于替换时查找
    const colorMap = new Map(keywords.map((k) => [k.text, k.color]));

    // stream 模式的 TextDecoder，自动处理不完整的 UTF-8 尾部字节
    const decoder = new TextDecoder('utf-8');

    /**
     * 对文本应用关键词高亮
     * 将匹配到的关键词用 ANSI 颜色序列包裹
     */
    function highlight(text: string): string {
        return text.replace(pattern, (match) => {
            const color = colorMap.get(match);
            return color ? `${color}${match}${ANSI_RESET}` : match;
        });
    }

    return {
        /**
         * 处理一块字节数据
         *
         * @param bytes SSH 输出的原始字节数据
         * @returns 高亮处理后的字符串（含 ANSI 转义序列），可直接写入 xterm
         */
        process(bytes: Uint8Array): string {
            // stream: true 让 TextDecoder 缓存不完整的多字节序列
            // 下次调用时会自动拼接，避免 UTF-8 字符被拆分到两个包时产生乱码
            const text = decoder.decode(bytes, { stream: true });
            return highlight(text);
        },

        /**
         * 刷新解码器中残留的字节
         * 在连接关闭时调用，输出缓冲区中剩余的数据
         */
        flush(): string {
            const text = decoder.decode();
            return highlight(text);
        },
    };
}
