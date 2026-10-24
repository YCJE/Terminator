// 系统级通知封装：仅在窗口隐藏时调用，失败时静默降级为应用内提示。
// WebView2 对 Notification 的支持依赖系统设置，因此所有异常都必须吞掉。

export function showDesktopNotification(title: string, body: string): void {
    try {
        if (typeof Notification === "undefined") return;
        const create = () => {
            try {
                new Notification(title, { body });
            } catch {
                // 系统禁用通知时忽略
            }
        };
        if (Notification.permission === "granted") {
            create();
        } else if (Notification.permission === "default") {
            Notification.requestPermission()
                .then((permission) => {
                    if (permission === "granted") create();
                })
                .catch(() => {});
        }
    } catch {
        // 忽略不支持的环境
    }
}
