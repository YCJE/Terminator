// 远端路径与 shell 参数处理（拖拽上传等场景使用）。
// 与 SFTP 面板的路径拼接逻辑保持一致的 POSIX 语义。

/** SFTP 文件行拖到终端时使用的内部 MIME，只传远端路径，不复制文件内容 */
export const REMOTE_PATH_MIME = "application/x-terminator-remote-path";

/** 拖到本地文件栏时使用的内部 MIME：JSON 数组，支持多选拖动 */
export const REMOTE_PATHS_MIME = "application/x-terminator-remote-paths";

/** 本地文件行拖动时使用的内部 MIME：JSON 数组，供远端栏上传使用 */
export const LOCAL_PATHS_MIME = "application/x-terminator-local-paths";

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
 * 拼接本地路径
 * 分隔符跟随目录本身：Windows 目录用反斜杠、POSIX 目录用斜杠，
 * 避免出现 "C:\dir/name" 这类混合分隔符。
 */
export function joinLocalPath(dir: string, name: string): string {
    if (!dir) return name;
    if (dir.endsWith("\\") || dir.endsWith("/")) return dir + name;
    const sep = dir.includes("\\") ? "\\" : "/";
    return `${dir}${sep}${name}`;
}

/**
 * 用单引号包裹路径，转义内部的单引号，避免空格/特殊字符被 shell 解析。
 * 例：/tmp/a b'c → '/tmp/a b'\''c'
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 判断 shell 是否为 PowerShell 系（pwsh.exe / powershell.exe）。
 */
function isPowerShell(shell: string): boolean {
    const base = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return base.includes("pwsh") || base.includes("powershell");
}

/** 判断 shell 是否为 POSIX 系（bash / zsh / sh / fish / dash）。 */
function isPosixShell(shell: string): boolean {
    const base = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return ["bash.exe", "bash", "zsh.exe", "zsh", "sh.exe", "sh", "fish.exe", "fish", "dash"]
        .includes(base);
}

/**
 * 本地 shell 的路径引用。
 *
 * 双引号会展开 `$(...)` 与反引号：把名为 `$(calc).txt` 的文件拖入终端
 * 就会被 shell 当作命令执行。因此：
 * - PowerShell 用单引号（内部单引号写成两个）；
 * - POSIX shell 也用单引号（内部单引号用 '\'' 拼接）；
 * - 尚未取到 shell 时按 PowerShell 处理（Windows 端默认是 PowerShell）。
 * cmd 不支持单引号，仍用双引号（`%VAR%` 在命令行无法安全转义，属已知限制）。
 */
export function quoteLocalPath(path: string, shell?: string): string {
    if (shell && isPosixShell(shell)) {
        return shellQuote(path);
    }
    if (!shell || isPowerShell(shell)) {
        return `'${path.replace(/'/g, "''")}'`;
    }
    return `"${path.replace(/"/g, '\\"')}"`;
}
