// 应用外观：主窗口与浮动窗口共用同一套"后端设置 → 前端 store → document"同步逻辑。
//
// 浮动窗口是独立 webview，store 是全新的实例；它必须自己读一次后端设置，
// 否则主题、强调色、语言会回退到默认值，与主窗口不一致。

import i18n from "@/i18n";
import { SettingsService } from "../../bindings/terminator-desktop/backend/internal/services/settings";
import { useUIStore, type AccentColor, type Skin, type Spaciness } from "@/store/uiStore";

export const VALID_ACCENTS: AccentColor[] = ["monochrome", "sky", "emerald", "violet", "amber", "rose", "cyan"];
export const VALID_SPACINESS: Spaciness[] = [0.8, 1, 1.2];
export const VALID_SKINS: Skin[] = ["default", "hud", "editorial"];

/** 从后端读取外观设置并同步到 store（语言变化时同时切换 i18n）。 */
export async function syncAppearanceFromSettings(): Promise<void> {
    const settings = await SettingsService.GetSettings();
    const ui = useUIStore.getState();

    if (settings.language && settings.language !== i18n.language) {
        void i18n.changeLanguage(settings.language);
    } else if (!settings.language) {
        // 首次启动默认中文
        void i18n.changeLanguage("zh");
    }

    // 主题缺省为深色；其余外观字段只接受合法值，避免坏数据把界面弄花
    ui.setTheme(settings.theme === "light" ? "light" : "dark");
    if (settings.accent_color && VALID_ACCENTS.includes(settings.accent_color as AccentColor)) {
        ui.setAccentColor(settings.accent_color as AccentColor);
    }
    if (settings.spaciness && settings.spaciness > 0
        && VALID_SPACINESS.includes(settings.spaciness as Spaciness)) {
        ui.setSpaciness(settings.spaciness as Spaciness);
    }
    if (settings.skin && VALID_SKINS.includes(settings.skin as Skin)) {
        ui.setSkin(settings.skin as Skin);
    }
    ui.setTerminalColorLink(settings.terminal_color_link);
}

/** 皮肤自带明暗属性：HUD 强制暗、编辑纸感强制亮；default 跟随主题。 */
export function isDarkAppearance(theme: string, skin: Skin): boolean {
    if (skin === "hud") return true;
    if (skin === "editorial") return false;
    return theme === "dark";
}

/** 把 store 中的外观写入 document 根元素（主题类、皮肤、强调色、密度）。 */
export function applyAppearanceToDocument(): void {
    const ui = useUIStore.getState();
    document.documentElement.classList.toggle("dark", isDarkAppearance(ui.theme, ui.skin));
    document.documentElement.setAttribute("data-skin", ui.skin);
    document.documentElement.setAttribute("data-accent", ui.accentColor);
    document.documentElement.style.setProperty("--spaciness", String(ui.spaciness));
}
