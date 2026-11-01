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
    // 与外壳 --surface-0（#111219）一致：终端画布与工作区同色，
    // 面板内边距处不会出现深浅接缝
    background: "#111219",
    foreground: "#e4e4e7",
    cursor: "#a5b4fc",
    cursorAccent: "#111219",
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
export type AccentColorName = "monochrome" | "sky" | "emerald" | "violet" | "amber" | "rose" | "cyan";
export type TerminalSkinName = "default" | "hud" | "editorial";
/**
 * 终端配色方案
 * default 跟随应用明暗主题与强调色；custom 使用用户自定义的 ANSI 色板；
 * 其余为固定的经典终端调色板。
 */
export type TerminalColorScheme =
    | "default"
    | "custom"
    | "dracula"
    | "one-dark"
    | "nord"
    | "solarized-dark"
    | "solarized-light"
    | "tokyo-night"
    | "gruvbox"
    | "monokai";

/** 设置页下拉选项：labelKey 指向 settings 命名空间的文案 */
export const TERMINAL_COLOR_SCHEME_PRESETS: { value: TerminalColorScheme; labelKey: string }[] = [
    { value: "default", labelKey: "scheme_default" },
    { value: "custom", labelKey: "scheme_custom" },
    { value: "dracula", labelKey: "scheme_dracula" },
    { value: "one-dark", labelKey: "scheme_one_dark" },
    { value: "nord", labelKey: "scheme_nord" },
    { value: "solarized-dark", labelKey: "scheme_solarized_dark" },
    { value: "solarized-light", labelKey: "scheme_solarized_light" },
    { value: "tokyo-night", labelKey: "scheme_tokyo_night" },
    { value: "gruvbox", labelKey: "scheme_gruvbox" },
    { value: "monokai", labelKey: "scheme_monokai" },
];

/** 校验从 localStorage 读出的值是否为合法配色方案 */
export function isTerminalColorScheme(value: string): value is TerminalColorScheme {
    return TERMINAL_COLOR_SCHEME_PRESETS.some((preset) => preset.value === value);
}

/** 自定义配色的颜色键：背景/前景/光标 + ANSI 16 色 */
export type CustomTerminalColorKey =
    | "background"
    | "foreground"
    | "cursor"
    | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
    | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
    | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export type CustomTerminalColors = Record<CustomTerminalColorKey, string>;

/** 自定义配色的初始值：沿用默认深色方案，用户在此基础上逐色调整 */
export const DEFAULT_CUSTOM_TERMINAL_COLORS: CustomTerminalColors = {
    background: "#111219",
    foreground: "#e4e4e7",
    cursor: "#a5b4fc",
    black: "#1e1e26",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
};

/** 校验 #RRGGBB 颜色值（<input type="color"> 只接受该格式） */
export function isHexColor(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value);
}

/** 把 #RRGGBB 转成带透明度的 rgba()，用于按自定义前景色推导选区底色 */
function hexToRgba(hex: string, alpha: number): string {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!match) return `rgba(255, 255, 255, ${alpha})`;
    return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
}

/**
 * 固定配色方案的调色板
 * 每套都带完整的 ANSI 16 色，避免 xterm 回退到默认色后与背景撞色；
 * 240 个扩展色统一复用 EXTENDED_256，保证跨方案一致。
 */
const SCHEME_THEMES: Record<Exclude<TerminalColorScheme, "default" | "custom">, ITheme> = {
    "dracula": {
        background: "#282a36",
        foreground: "#f8f8f2",
        cursor: "#f8f8f2",
        cursorAccent: "#282a36",
        selectionBackground: "rgba(68, 71, 90, 0.9)",
        selectionInactiveBackground: "rgba(68, 71, 90, 0.4)",
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
        extendedAnsi: EXTENDED_256,
    },
    "one-dark": {
        background: "#282c34",
        foreground: "#abb2bf",
        cursor: "#528bff",
        cursorAccent: "#282c34",
        selectionBackground: "rgba(62, 68, 81, 0.9)",
        selectionInactiveBackground: "rgba(62, 68, 81, 0.4)",
        black: "#282c34",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
        extendedAnsi: EXTENDED_256,
    },
    "nord": {
        background: "#2e3440",
        foreground: "#d8dee9",
        cursor: "#d8dee9",
        cursorAccent: "#2e3440",
        selectionBackground: "rgba(67, 76, 94, 0.9)",
        selectionInactiveBackground: "rgba(67, 76, 94, 0.4)",
        black: "#3b4252",
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        white: "#e5e9f0",
        brightBlack: "#4c566a",
        brightRed: "#bf616a",
        brightGreen: "#a3be8c",
        brightYellow: "#ebcb8b",
        brightBlue: "#81a1c1",
        brightMagenta: "#b48ead",
        brightCyan: "#8fbcbb",
        brightWhite: "#eceff4",
        extendedAnsi: EXTENDED_256,
    },
    "solarized-dark": {
        background: "#002b36",
        foreground: "#839496",
        cursor: "#93a1a1",
        cursorAccent: "#002b36",
        selectionBackground: "rgba(7, 54, 66, 0.9)",
        selectionInactiveBackground: "rgba(7, 54, 66, 0.4)",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#002b36",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
        extendedAnsi: EXTENDED_256,
    },
    "solarized-light": {
        background: "#fdf6e3",
        foreground: "#657b83",
        cursor: "#586e75",
        cursorAccent: "#fdf6e3",
        selectionBackground: "rgba(238, 232, 213, 0.95)",
        selectionInactiveBackground: "rgba(238, 232, 213, 0.5)",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#002b36",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
        extendedAnsi: EXTENDED_256,
    },
    "tokyo-night": {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        cursorAccent: "#1a1b26",
        selectionBackground: "rgba(51, 70, 124, 0.9)",
        selectionInactiveBackground: "rgba(51, 70, 124, 0.4)",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
        extendedAnsi: EXTENDED_256,
    },
    "gruvbox": {
        background: "#282828",
        foreground: "#ebdbb2",
        cursor: "#ebdbb2",
        cursorAccent: "#282828",
        selectionBackground: "rgba(80, 73, 69, 0.9)",
        selectionInactiveBackground: "rgba(80, 73, 69, 0.4)",
        black: "#282828",
        red: "#cc241d",
        green: "#98971a",
        yellow: "#d79921",
        blue: "#458588",
        magenta: "#b16286",
        cyan: "#689d6a",
        white: "#a89984",
        brightBlack: "#928374",
        brightRed: "#fb4934",
        brightGreen: "#b8bb26",
        brightYellow: "#fabd2f",
        brightBlue: "#83a598",
        brightMagenta: "#d3869b",
        brightCyan: "#8ec07c",
        brightWhite: "#ebdbb2",
        extendedAnsi: EXTENDED_256,
    },
    "monokai": {
        background: "#272822",
        foreground: "#f8f8f2",
        cursor: "#f8f8f2",
        cursorAccent: "#272822",
        selectionBackground: "rgba(73, 72, 62, 0.9)",
        selectionInactiveBackground: "rgba(73, 72, 62, 0.4)",
        black: "#272822",
        red: "#f92672",
        green: "#a6e22e",
        yellow: "#f4bf75",
        blue: "#66d9ef",
        magenta: "#ae81ff",
        cyan: "#a1efe4",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#f92672",
        brightGreen: "#a6e22e",
        brightYellow: "#f4bf75",
        brightBlue: "#66d9ef",
        brightMagenta: "#ae81ff",
        brightCyan: "#a1efe4",
        brightWhite: "#ffffff",
        extendedAnsi: EXTENDED_256,
    },
};

/** 内置字体栈：按优先级回退，保证中英文都有等宽字体可用 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
    '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace';

/**
 * 解析最终字体栈
 * 用户自定义字体名前置、内置字体栈兜底：字体未安装或名字拼错时
 * 自动回退到等宽字体，而不是退化成系统默认的非等宽字体。
 */
export function resolveTerminalFontFamily(family?: string): string {
    const custom = family?.trim();
    return custom ? `${custom}, ${DEFAULT_TERMINAL_FONT_FAMILY}` : DEFAULT_TERMINAL_FONT_FAMILY;
}

/**
 * 终端外观覆盖项
 * 由设置页 / Ctrl+滚轮缩放写入，TerminalInstance 初始化与热更新时传入。
 * 未提供的字段使用默认值，避免调用方每次都要填全套。
 */
export interface TerminalAppearance {
    fontSize?: number;
    /** 用户自定义字体族；空字符串表示使用内置字体栈 */
    fontFamily?: string;
    lineHeight?: number;
    cursorStyle?: "block" | "bar" | "underline";
    cursorBlink?: boolean;
    scrollback?: number;
}

/**
 * 皮肤对终端底色的覆盖
 * 让终端画布与外壳表面同色，避免面板内边距处出现色差接缝。
 * 仅覆盖底色/前景/光标/选区，ANSI 16 色与 256 色扩展调色板保持不变。
 */
const SKIN_TERMINAL_SURFACE: Record<"hud" | "editorial", {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    selectionInactiveBackground: string;
}> = {
    hud: {
        background: "#05070a",
        foreground: "#d3ece7",
        cursor: "#46e6c0",
        selectionBackground: "rgba(70, 230, 192, 0.25)",
        selectionInactiveBackground: "rgba(70, 230, 192, 0.10)",
    },
    editorial: {
        background: "#fbf9f4",
        foreground: "#1a1917",
        cursor: "#b0382a",
        selectionBackground: "rgba(176, 56, 42, 0.18)",
        selectionInactiveBackground: "rgba(176, 56, 42, 0.08)",
    },
};

/** 各强调色对应的终端 ANSI 蓝色/青色替换值 */
const ACCENT_TERMINAL_COLORS: Partial<Record<AccentColorName, { dark: { blue: string; cyan: string; cursor: string }; light: { blue: string; cyan: string; cursor: string } }>> = {
    sky:     { dark: { blue: "#60a5fa", cyan: "#22d3ee", cursor: "#a5b4fc" }, light: { blue: "#2563eb", cyan: "#0891b2", cursor: "#4f46e5" } },
    emerald: { dark: { blue: "#4ade80", cyan: "#22d3ee", cursor: "#6ee7b7" }, light: { blue: "#16a34a", cyan: "#0891b2", cursor: "#059669" } },
    violet:  { dark: { blue: "#c084fc", cyan: "#22d3ee", cursor: "#d8b4fe" }, light: { blue: "#9333ea", cyan: "#0891b2", cursor: "#7c3aed" } },
    amber:   { dark: { blue: "#fbbf24", cyan: "#22d3ee", cursor: "#fcd34d" }, light: { blue: "#d97706", cyan: "#0891b2", cursor: "#b45309" } },
    rose:    { dark: { blue: "#fb7185", cyan: "#22d3ee", cursor: "#fda4af" }, light: { blue: "#e11d48", cyan: "#0891b2", cursor: "#be123c" } },
    cyan:    { dark: { blue: "#22d3ee", cyan: "#60a5fa", cursor: "#67e8f9" }, light: { blue: "#0891b2", cyan: "#2563eb", cursor: "#0e7490" } },
};

/** 根据主题名称获取终端配置 */
export function getTerminalTheme(
    theme: TerminalThemeName,
    accentColor?: AccentColorName,
    skin?: TerminalSkinName,
    appearance?: TerminalAppearance,
    colorScheme: TerminalColorScheme = "default",
    customColors?: CustomTerminalColors,
) {
    // 皮肤对明暗有强制语义（HUD 恒暗、编辑纸感恒亮），与 App 中 effectiveDark 的
    // 判定保持一致。若这里仍只看 theme，在「浅色主题 + HUD」这类组合下会得到
    // 深色画布配浅色主题的 ANSI 色（深色字压深色底），对比度严重不足。
    const isDark = skin === "hud" ? true : skin === "editorial" ? false : theme !== "light";
    // 固定配色优先：选中经典方案后底色/前景/ANSI 色都由方案决定，
    // 不再随应用明暗主题切换（否则 Solarized Light 会被浅色主题二次覆盖）。
    // custom 方案以默认深色为底，逐色覆盖用户调整过的值。
    const custom = {...DEFAULT_CUSTOM_TERMINAL_COLORS, ...(customColors ?? {})};
    const scheme: ITheme | undefined = colorScheme === "default"
        ? undefined
        : colorScheme === "custom"
            ? {
                ...DARK_THEME,
                ...custom,
                cursorAccent: custom.background,
                // 选区底色跟随用户自定义的前景色，避免与自定义背景撞色
                selectionBackground: hexToRgba(custom.foreground, 0.25),
                selectionInactiveBackground: hexToRgba(custom.foreground, 0.1),
                extendedAnsi: EXTENDED_256,
            }
            : SCHEME_THEMES[colorScheme];
    let baseTheme: ITheme = scheme ? {...scheme} : isDark ? DARK_THEME : LIGHT_THEME;

    // 皮肤底色覆盖：终端画布与外壳表面同色
    if (skin === "hud" || skin === "editorial") {
        const surface = SKIN_TERMINAL_SURFACE[skin];
        baseTheme = {
            ...baseTheme,
            background: surface.background,
            foreground: surface.foreground,
            cursor: surface.cursor,
            cursorAccent: surface.background,
            selectionBackground: surface.selectionBackground,
            selectionInactiveBackground: surface.selectionInactiveBackground,
        };
    }

    // 强调色联动只对"默认"配色生效：固定方案有各自成体系的蓝/青/光标色，
    // 用应用强调色替换会破坏配色本身的对比度关系。
    if (colorScheme === "default" && accentColor && ACCENT_TERMINAL_COLORS[accentColor]) {
        const accentColors = ACCENT_TERMINAL_COLORS[accentColor][isDark ? "dark" : "light"];
        baseTheme = {
            ...baseTheme,
            blue: accentColors.blue,
            brightBlue: accentColors.blue,
            cyan: accentColors.cyan,
            brightCyan: accentColors.cyan,
            cursor: accentColors.cursor,
            selectionBackground: `${accentColors.blue}40`,
            selectionInactiveBackground: `${accentColors.blue}20`,
        };
    }

    // 用户自定义字体名追加在内置字体栈之前：字体未安装时自动回退，
    // 避免自定义字体拼写错误导致终端退化成非等宽的系统默认字体。
    const fontFamily = resolveTerminalFontFamily(appearance?.fontFamily);

    return {
        fontFamily,
        fontSize: appearance?.fontSize ?? 14,
        lineHeight: appearance?.lineHeight ?? 1.3,
        cursorBlink: appearance?.cursorBlink ?? true,
        cursorStyle: appearance?.cursorStyle ?? ("bar" as const),
        scrollback: appearance?.scrollback ?? 10000,
        allowProposedApi: true,
        theme: baseTheme,
    };
}

/**
 * 设置页色卡预览
 * 返回方案的实际底色与红/绿/黄/蓝，用于在设置项右侧显示配色小样。
 * default 方案会按当前主题/强调色/皮肤计算，预览与真实终端保持一致。
 */
export function getTerminalSchemePreview(
    colorScheme: TerminalColorScheme,
    theme: TerminalThemeName,
    accentColor?: AccentColorName,
    skin?: TerminalSkinName,
    customColors?: CustomTerminalColors,
): string[] {
    const palette = getTerminalTheme(theme, accentColor, skin, undefined, colorScheme, customColors).theme;
    return [
        palette.background ?? "#000000",
        palette.red ?? "#ff0000",
        palette.green ?? "#00ff00",
        palette.yellow ?? "#ffff00",
        palette.blue ?? "#0000ff",
    ];
}

/** 兼容旧引用 — 默认深色 */
export const TERMINAL_THEME = getTerminalTheme("dark");

/**
 * 终端配色联动
 * 当开启时，终端的 ANSI 蓝色/青色跟随 UI 强调色变化
 * 不再覆盖 UI --primary，让强调色在 UI 和终端两侧同时生效
 */
export function applyTerminalColorLink(theme: TerminalThemeName, accentColor: AccentColorName, enabled: boolean): void {
    if (!enabled) {
        // 关闭联动时无需操作 CSS 变量（之前也没有覆盖）
        return;
    }
    // 开启联动时也不覆盖 UI --primary，让 data-accent CSS 正常生效
    // 终端侧的配色变化由 TerminalInstance 组件监听 accentColor 变化自动处理
}
