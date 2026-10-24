// 终端自定义高亮规则：类型、颜色映射与本地持久化。
//
// 规则只保存在 localStorage（纯前端特性），不涉及后端与同步。
// 正则非法或匹配空字符串的规则在应用时会被跳过，避免污染整段输出。

export type HighlightColor = "red" | "yellow" | "green" | "cyan" | "magenta" | "orange";

export interface HighlightRule {
    id: string;
    /** 关键字或正则表达式 */
    pattern: string;
    /** true 表示按正则解析 pattern */
    regex: boolean;
    color: HighlightColor;
    enabled: boolean;
}

/** 颜色 → ANSI SGR；标签文案由 settings 命名空间下的 highlight_color_* 提供 */
export const HIGHLIGHT_COLORS: { value: HighlightColor; sgr: string; hex: string; labelKey: string }[] = [
    { value: "red", sgr: "\x1b[1;91m", hex: "#ef4444", labelKey: "highlight_color_red" },
    { value: "yellow", sgr: "\x1b[1;93m", hex: "#eab308", labelKey: "highlight_color_yellow" },
    { value: "green", sgr: "\x1b[1;92m", hex: "#22c55e", labelKey: "highlight_color_green" },
    { value: "cyan", sgr: "\x1b[1;96m", hex: "#06b6d4", labelKey: "highlight_color_cyan" },
    { value: "magenta", sgr: "\x1b[1;95m", hex: "#d946ef", labelKey: "highlight_color_magenta" },
    { value: "orange", sgr: "\x1b[1;38;5;208m", hex: "#f97316", labelKey: "highlight_color_orange" },
];

const STORAGE_KEY = "terminator_highlight_rules_v1";
const DEFAULT_COLOR: HighlightColor = "yellow";
const MAX_RULES = 50;

export function sgrForColor(color: HighlightColor): string {
    return HIGHLIGHT_COLORS.find((c) => c.value === color)?.sgr ?? HIGHLIGHT_COLORS[1].sgr;
}

function isHighlightColor(value: unknown): value is HighlightColor {
    return HIGHLIGHT_COLORS.some((c) => c.value === value);
}

/** 校验并清理外部数据，丢弃结构不合法的条目。 */
export function sanitizeHighlightRules(raw: unknown): HighlightRule[] {
    if (!Array.isArray(raw)) return [];
    const rules: HighlightRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Partial<HighlightRule>;
        if (typeof r.pattern !== "string" || r.pattern.length === 0) continue;
        rules.push({
            id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
            pattern: r.pattern.slice(0, 200),
            regex: r.regex === true,
            color: isHighlightColor(r.color) ? r.color : DEFAULT_COLOR,
            enabled: r.enabled !== false,
        });
        if (rules.length >= MAX_RULES) break;
    }
    return rules;
}

export function loadHighlightRules(): HighlightRule[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? sanitizeHighlightRules(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
}

export function saveHighlightRules(rules: HighlightRule[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
    } catch {
        // localStorage 不可用时静默忽略
    }
}
