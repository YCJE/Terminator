/**
 * 终端主题配置
 *
 * 为深色和浅色主题分别提供完整的 ANSI 16 色 + 256 色调色板。
 * 深色主题用 Abyss 配色，浅色主题用 Frost 配色。
 */

import type { ITheme } from "@xterm/xterm";

// 生成 xterm 256 色调色板中 6×6×6 立方体部分 (索引 16-231)
function generateColorCube(): string[] {
    const colors: string[] = [];
    const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    for (let r = 0; r < 6; r++) {
        for (let g = 0; g < 6; g++) {
            for (let b = 0; b < 6; b++) {
                colors.push(`#${levels[r].toString(16).padStart(2, '0')}${levels[g].toString(16).padStart(2, '0')}${levels[b].toString(16).padStart(2, '0')}`);
            }
        }
    }
    return colors;
}

// 生成灰阶部分 (索引 232-255)
function generateGrayscale(): string[] {
    const colors: string[] = [];
    for (let i = 0; i < 24; i++) {
        const v = 8 + i * 10;
        const hex = v.toString(16).padStart(2, '0');
        colors.push(`#${hex}${hex}${hex}`);
    }
    return colors;
}

// 完整的 256 色扩展调色板 (索引 16-255，共 240 个颜色)
const EXTENDED_256 = [...generateColorCube(), ...generateGrayscale()];

/** 深色终端主题（Abyss）— 深底浅字，高饱和度 ANSI 色 */
const DARK_THEME: ITheme = {
    background: "#0e0e12",
    foreground: "#e4e4e7",
    cursor: "#a5b4fc",
    cursorAccent: "#0e0e12",
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

    // 扩展色 (16-255)
    extendedAnsi: EXTENDED_256,
};

/** 浅色终端主题（Frost）— 白底深字，适当调暗 ANSI 色保证对比度 */
const LIGHT_THEME: ITheme = {
    background: "#fafafa",
    foreground: "#27272a",
    cursor: "#4f46e5",
    cursorAccent: "#fafafa",
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

    extendedAnsi: EXTENDED_256,
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

/**
 * 终端配色 → UI primary 色联动（借鉴 Tabby "Follow the color scheme"）
 * 提取终端主题的蓝色（ANSI color 4），设为 UI --primary CSS 变量
 * 使整个应用的强调色跟随终端配色方案变化
 */
export function applyTerminalColorLink(theme: TerminalThemeName, enabled: boolean): void {
    const termTheme = theme !== "light" ? DARK_THEME : LIGHT_THEME;
    const blue = termTheme.blue || "#58a6ff";

    if (enabled) {
        // 将终端蓝色设为 UI primary
        document.documentElement.style.setProperty("--primary", blue);
        document.documentElement.style.setProperty("--ring", blue);
        document.documentElement.style.setProperty("--sidebar-primary", blue);
        document.documentElement.style.setProperty("--sidebar-ring", blue);
    } else {
        // 恢复为 CSS 变量默认值（移除内联覆盖）
        document.documentElement.style.removeProperty("--primary");
        document.documentElement.style.removeProperty("--ring");
        document.documentElement.style.removeProperty("--sidebar-primary");
        document.documentElement.style.removeProperty("--sidebar-ring");
    }
}
