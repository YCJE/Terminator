// 远端路径与 shell 参数处理（拖拽上传等场景使用）。
// 与 SFTP 面板的路径拼接逻辑保持一致的 POSIX 语义。

/** SFTP 文件行拖到终端时使用的内部 MIME，只传远端路径，不复制文件内容 */
export const REMOTE_PATH_MIME = "application/x-terminator-remote-path";

/** 取本地路径的文件名，兼容 Windows 反斜杠。 */
export function localBasename(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

/** 拼接远端 POSIX 路径，避免重复斜杠。 */
export function joinRemotePath(base: string, name: string): string {
    if (!base || base === "/") return `/${name}`;
    return base.endsWith("/") ? base + name : `${base}/${name}`;
}

/**
 * 用单引号包裹路径，转义内部的单引号，避免空格/特殊字符被 shell 解析。
 * 例：/tmp/a b'c → '/tmp/a b'\''c'
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 本地 shell 的路径引用：Windows cmd/PowerShell 与 POSIX 都接受双引号，
 * 内部双引号做最小转义。仅用于把拖入的文件路径插入命令行。
 */
export function quoteLocalPath(path: string): string {
    return `"${path.replace(/"/g, '\\"')}"`;
}
