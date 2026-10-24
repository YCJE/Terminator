// 外部链接打开：只允许 http/https，统一交给系统浏览器。
// 终端里点击 URL、划词搜索都走这里，避免把 webview 变成内嵌浏览器。

import { Browser } from "@wailsio/runtime";

export function openExternalUrl(url: string): void {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        Browser.OpenURL(parsed.toString()).catch(console.error);
    } catch {
        // 非法 URL 静默忽略
    }
}

export function searchBing(query: string): void {
    openExternalUrl(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
}

export function searchGitHub(query: string): void {
    openExternalUrl(`https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`);
}
