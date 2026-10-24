// 可配置快捷键：定义、持久化与匹配。
//
// 只做"按键 → 动作"的映射，不绑定具体业务；消费方在事件里调用 matchesCombo 判断。
// 组合必须包含 Ctrl 或 Alt，避免占用普通输入按键。

export type ShortcutId = "palette" | "search" | "splitRow" | "splitColumn" | "compose";

export interface ShortcutCombo {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    /** KeyboardEvent.code，例如 KeyP / F2 */
    code: string;
}

/** 可配置动作的默认组合与文案键（settings 命名空间） */
export const SHORTCUT_DEFS: {
    id: ShortcutId;
    defaultCombo: ShortcutCombo;
    labelKey: string;
}[] = [
    {
        id: "palette",
        defaultCombo: { ctrl: true, alt: false, shift: true, code: "KeyP" },
        labelKey: "shortcut_palette",
    },
    {
        id: "search",
        defaultCombo: { ctrl: true, alt: false, shift: false, code: "KeyF" },
        labelKey: "shortcut_search",
    },
    {
        id: "splitRow",
        defaultCombo: { ctrl: true, alt: false, shift: true, code: "KeyD" },
        labelKey: "shortcut_split_vertical",
    },
    {
        id: "splitColumn",
        defaultCombo: { ctrl: true, alt: false, shift: true, code: "KeyE" },
        labelKey: "shortcut_split_horizontal",
    },
    {
        id: "compose",
        defaultCombo: { ctrl: true, alt: false, shift: true, code: "KeyU" },
        labelKey: "shortcut_compose",
    },
];

const STORAGE_KEY = "terminator_shortcuts_v1";

// 设置页录制期间置为 true，消费点据此暂停响应全局快捷键，
// 避免录制时触发命令面板等动作。
let recording = false;

export function setShortcutRecording(value: boolean): void {
    recording = value;
}

export function isShortcutRecording(): boolean {
    return recording;
}

export type ShortcutMap = Record<ShortcutId, ShortcutCombo>;

export const DEFAULT_SHORTCUTS: ShortcutMap = SHORTCUT_DEFS.reduce((map, def) => {
    map[def.id] = { ...def.defaultCombo };
    return map;
}, {} as ShortcutMap);

export function combosEqual(a: ShortcutCombo, b: ShortcutCombo): boolean {
    return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code;
}

export function matchesCombo(event: KeyboardEvent, combo: ShortcutCombo): boolean {
    return (
        event.ctrlKey === combo.ctrl &&
        event.altKey === combo.alt &&
        event.shiftKey === combo.shift &&
        event.code === combo.code
    );
}

/** 从键盘事件提取组合；纯修饰键或缺少 Ctrl/Alt 时返回 null */
export function comboFromEvent(event: KeyboardEvent): ShortcutCombo | null {
    const code = event.code;
    if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return null;
    if (!event.ctrlKey && !event.altKey) return null;
    return {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        code,
    };
}

/** 把 KeyboardEvent.code 转为便于阅读的键名 */
function codeLabel(code: string): string {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    const named: Record<string, string> = {
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        Escape: "Esc",
        Space: "Space",
        Backslash: "\\",
        Slash: "/",
        Comma: ",",
        Period: ".",
        Minus: "-",
        Equal: "=",
        Semicolon: ";",
        Quote: "'",
        Backquote: "`",
        BracketLeft: "[",
        BracketRight: "]",
        Enter: "Enter",
        Tab: "Tab",
        Backspace: "Backspace",
        Delete: "Delete",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
    };
    return named[code] ?? code;
}

export function comboLabel(combo: ShortcutCombo): string {
    const parts: string[] = [];
    if (combo.ctrl) parts.push("Ctrl");
    if (combo.alt) parts.push("Alt");
    if (combo.shift) parts.push("Shift");
    parts.push(codeLabel(combo.code));
    return parts.join("+");
}

function sanitizeCombo(raw: unknown): ShortcutCombo | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<ShortcutCombo>;
    if (typeof value.code !== "string" || !value.code) return null;
    if (value.ctrl !== true && value.alt !== true) return null;
    return {
        ctrl: value.ctrl === true,
        alt: value.alt === true,
        shift: value.shift === true,
        code: value.code,
    };
}

/** 读取本地覆盖；缺失或非法的动作回退到默认组合 */
export function loadShortcuts(): ShortcutMap {
    const result: ShortcutMap = { ...DEFAULT_SHORTCUTS };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return result;
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object") return result;
        for (const def of SHORTCUT_DEFS) {
            const combo = sanitizeCombo(parsed[def.id]);
            if (combo) result[def.id] = combo;
        }
    } catch {
        // 数据损坏时使用默认值
    }
    return result;
}

export function saveShortcuts(map: ShortcutMap): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // localStorage 不可用时静默忽略
    }
}
