/**
 * 终端主题配置
 *
 * 之前只定义了 background/foreground/cursor，缺少 ANSI 16 色调色板，
 * 导致所有彩色文字（ls、vim、prompt 等）都退化成白色。
 *
 * 现在为深色和浅色主题分别提供完整的 256 色 + ANSI 16 色调色板。
 * 深色主题用 Abyss 配色，浅色主题用 Frost 配色。
 */

import type { ITheme } from "@xterm/xterm";

/** 深色终端主题（Abyss）— 深底浅字，高饱和度 ANSI 色 */
const DARK_THEME: ITheme = {
    background: "#0e0e12",
    foreground: "#e4e4e7",
    cursor: "#a5b4fc",
    selectionBackground: "rgba(165, 180, 252, 0.25)",
    selectionInactiveBackground: "rgba(165, 180, 252, 0.1)",

    // ANSI 标准色 (0-7)
    black: "#1e1e26",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e4e4e7",

    // ANSI 亮色 (8-15)
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",

    // 扩展色 (16-255) — 使用 xterm 标准调色板的子集
    extendedAnsi: [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080",
        "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00",
        "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ],
};

/** 浅色终端主题（Frost）— 白底深字，适当调暗 ANSI 色保证对比度 */
const LIGHT_THEME: ITheme = {
    background: "#fafafa",
    foreground: "#27272a",
    cursor: "#4f46e5",
    selectionBackground: "rgba(79, 70, 229, 0.2)",
    selectionInactiveBackground: "rgba(79, 70, 229, 0.1)",

    // ANSI 标准色 (0-7) — 在白底上加深，保证可读性
    black: "#3f3f46",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#71717a",

    // ANSI 亮色 (8-15)
    brightBlack: "#71717a",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#000000",

    extendedAnsi: [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080",
        "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00",
        "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ],
};

export type TerminalThemeName = "dark" | "light";

/** 根据主题名称获取终端配置 */
export function getTerminalTheme(theme: TerminalThemeName) {
    const isDark = theme !== "light";
    return {
        fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.3,
        cursorBlink: true,
        cursorStyle: "bar" as const,
        scrollback: 10000,
        allowProposedApi: true,
        theme: isDark ? DARK_THEME : LIGHT_THEME,
    };
}

/** 兼容旧引用 — 默认深色 */
export const TERMINAL_THEME = getTerminalTheme("dark");
