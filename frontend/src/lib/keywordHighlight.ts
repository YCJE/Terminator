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

import { sgrForColor } from "@/lib/highlightRules";
import type { HighlightRule } from "@/lib/highlightRules";

/** 关键词规则：文本 + 对应的 ANSI SGR 颜色序列 */
export interface KeywordRule {
    /** 关键词文本 */
    text: string;
    /** ANSI SGR 转义序列，如 '\x1b[1;91m' 表示粗体亮红色 */
    color: string;
}

/** ANSI 重置序列，清除所有文本属性 */
const ANSI_RESET = '\x1b[0m';

/** 自定义规则数量上限，避免大量正则在每块输出上重复执行 */
const MAX_CUSTOM_RULES = 50;
/** 单条正则源码长度上限 */
const MAX_PATTERN_LENGTH = 200;
/** 单块文本超过该长度时跳过自定义正则（内置关键词仍生效） */
const MAX_CUSTOM_HIGHLIGHT_TEXT = 100_000;

/**
 * 粗略识别可能引发灾难性回溯的正则（如 `(a+)+`、`(a|aa)+`）。
 *
 * JS 正则一旦进入指数级回溯无法中断，会卡死渲染线程。SSH 输出完全由远端
 * 控制（`printf 'a%.0s' {1..50000}` 再接一个不匹配字符即可触发），因此这类
 * 模式必须在编译前拒绝，不能寄希望于运行时中断。
 */
function isRiskyPattern(source: string): boolean {
    // 括号内已有量词，括号外再叠加量词："(a+)+"、"(a{1,5}){1,5}"
    if (/\([^()]*[+*?{][^()]*\)[+*{]/.test(source)) return true;
    // 括号内含交替且括号外有量词："(a|aa)+"
    if (/\([^()]*\|[^()]*\)[+*{]/.test(source)) return true;
    return false;
}

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
export function createKeywordHighlighter(
    keywords: KeywordRule[] = DEFAULT_KEYWORDS,
    getCustomRules?: () => HighlightRule[],
) {
    // 按关键词文本长度降序排列，确保 "WARNING" 优先于 "WARN" 匹配
    // 虽然单词边界 \b 已能处理此问题，但长词优先是更稳健的做法
    const sorted = [...keywords].sort((a, b) => b.text.length - a.text.length);

    // 构建匹配所有关键词的正则表达式，使用单词边界 \b 避免子串误匹配
    // 例如：\bfail\b 不会匹配 "failed" 中的 "fail"
    const pattern = sorted.length > 0
        ? new RegExp(
            `\\b(${sorted.map((k) => escapeRegExp(k.text)).join('|')})\\b`,
            'g',
        )
        : null;

    // 构建 关键词 → 颜色 的映射表，用于替换时查找
    const colorMap = new Map(keywords.map((k) => [k.text, k.color]));

    // 自定义规则按数组引用缓存编译结果：store 更新会替换数组引用。
    let lastRules: HighlightRule[] | null = null;
    let customMatchers: { re: RegExp; sgr: string }[] = [];

    function compileCustomRules(): { re: RegExp; sgr: string }[] {
        const rules = getCustomRules?.() ?? [];
        if (rules === lastRules) return customMatchers;
        lastRules = rules;

        const result: { re: RegExp; sgr: string }[] = [];
        for (const rule of rules.slice(0, MAX_CUSTOM_RULES)) {
            if (!rule.enabled || !rule.pattern) continue;
            // 用户自定义正则的语法校验在设置页，但 "(a+)+" 这类写法语法合法、
            // 引擎却会指数回溯，必须在编译前拒绝。
            if (rule.regex && (rule.pattern.length > MAX_PATTERN_LENGTH || isRiskyPattern(rule.pattern))) {
                continue;
            }
            const source = rule.regex ? rule.pattern : escapeRegExp(rule.pattern);
            try {
                // 跳过可匹配空字符串的规则，避免在每个字符之间插入颜色序列
                if (new RegExp(source).test("")) continue;
                result.push({ re: new RegExp(source, "g"), sgr: sgrForColor(rule.color) });
            } catch {
                // 非法正则静默跳过，设置页会提示规则无效
            }
        }
        customMatchers = result;
        return result;
    }

    // stream 模式的 TextDecoder，自动处理不完整的 UTF-8 尾部字节
    const decoder = new TextDecoder('utf-8');

    /**
     * 对文本应用关键词高亮
     * 将匹配到的关键词用 ANSI 颜色序列包裹
     */
    function highlight(text: string): string {
        // 先应用自定义规则，再应用内置关键词：内置规则优先级更高，
        // 例如用户高亮了普通文本，而其中含有 ERROR 时仍显示为错误色。
        let result = text;
        // 超长分片（如 cat 大文件）跳过自定义正则：同步回溯会卡死 UI。
        // 内置关键词由单个有界正则处理，仍继续执行。
        if (text.length <= MAX_CUSTOM_HIGHLIGHT_TEXT) {
            for (const { re, sgr } of compileCustomRules()) {
                result = result.replace(re, (match) => `${sgr}${match}${ANSI_RESET}`);
            }
        }
        if (!pattern) return result;
        return result.replace(pattern, (match) => {
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
