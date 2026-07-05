// 通用格式化工具函数

/**
 * 将字节数格式化为带单位的可读字符串（B/KB/MB/GB/TB）。
 * B 不保留小数，其余保留 1 位小数。
 */
export function formatFileSize(bytes: number): string {
    if (!bytes || bytes < 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const formatted = unitIndex === 0
        ? Math.round(value)
        : Math.round(value * 10) / 10;

    return `${formatted} ${units[unitIndex]}`;
}

/**
 * 将时间字符串格式化为 YYYY-MM-DD HH:mm。
 * 输入可以是 ISO 字符串或其他 Date 可解析的格式，解析失败时原样返回。
 */
export function formatDateTime(input: string): string {
    if (!input) return "";

    const date = new Date(input);
    if (isNaN(date.getTime())) return input;

    const pad = (n: number) => String(n).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
