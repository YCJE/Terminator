// 终端命令行补全建议：历史命令优先，其次内置常用命令。
//
// 只在"单行、当前输入像命令本身"时给出建议，含 shell 元字符、
// 引号或路径的输入交给远端 shell 自行补全，避免和原地补全打架。

import { loadAllComposeHistory, loadCommandFrequency } from "./commandHistory";
import { getRemoteHistory } from "./remoteHistory";

export type SuggestionSource = "history" | "builtin";

export interface CommandSuggestion {
    text: string;
    source: SuggestionSource;
}

/** 内置常用命令：仅用于首词补全，按字母序排列 */
const BUILTIN_COMMANDS: readonly string[] = [
    "alias", "apt", "apt-get", "awk", "bash", "bg", "bzip2", "cat", "cd", "chmod",
    "chown", "chroot", "clear", "cmp", "comm", "cp", "crontab", "curl", "cut", "date",
    "dd", "df", "diff", "dig", "dirs", "docker", "docker-compose", "du", "echo", "env",
    "export", "ffmpeg", "file", "find", "free", "fsck", "grep", "gunzip", "gzip", "head",
    "help", "history", "hostname", "htop", "id", "ifconfig", "ip", "journalctl", "kill", "killall",
    "kubectl", "last", "less", "ln", "locale", "locate", "ls", "lsblk", "lsof", "man",
    "mkdir", "mkfs", "mktemp", "more", "mount", "mv", "mysql", "nc", "netstat", "nice",
    "nohup", "npm", "nslookup", "openssl", "passwd", "ping", "pip", "pip3", "ps", "pwd",
    "python", "python3", "readlink", "reboot", "rename", "rm", "rmdir", "rsync", "scp", "screen",
    "sed", "service", "sh", "sha256sum", "shutdown", "sort", "source", "ssh", "ssh-keygen", "stat",
    "su", "sudo", "systemctl", "tail", "tar", "tee", "telnet", "time", "timeout", "tmux",
    "top", "touch", "tr", "traceroute", "tree", "umount", "unalias", "uniq", "unzip", "uptime",
    "useradd", "userdel", "usermod", "vi", "vim", "watch", "wc", "wget", "which", "who",
    "whoami", "xargs", "xxd", "yarn", "yum", "zip", "zsh",
];

interface HistorySnapshot {
    history: string[];
    frequency: Record<string, number>;
    loadedAt: number;
}

let snapshot: HistorySnapshot | null = null;
/** 历史与频次来自 localStorage，按键时不必每次都解析：短暂缓存即可 */
const SNAPSHOT_TTL = 5000;

function historySnapshot(): HistorySnapshot {
    const now = Date.now();
    if (snapshot && now - snapshot.loadedAt < SNAPSHOT_TTL) return snapshot;
    snapshot = {
        history: loadAllComposeHistory(200),
        frequency: loadCommandFrequency(),
        loadedAt: now,
    };
    return snapshot;
}

/**
 * 根据当前输入行给出补全建议。
 * - 远端 shell 历史（连接成功后读取）与本地草稿历史合并，
 *   按整行前缀匹配（支持 "git ch" → "git checkout main"），
 *   频次高、最近使用的排前面；
 * - 首词尚未输入空格时，补充内置常用命令。
 */
export function suggestCommands(line: string, limit = 6, sessionId?: string | null): CommandSuggestion[] {
    // 单字符建议噪音太大，且会频繁与 shell 补全冲突
    if (line.length < 2) return [];
    if (/[\r\n]/.test(line)) return [];
    // 复杂表达式 / 引号 / 转义：交给远端 shell
    if (/[|&;<>$`"'\\]/.test(line)) return [];
    const firstToken = line.split(/\s/, 1)[0] ?? "";
    // 以路径开头（./、~/、/usr/…）时由 shell 补全
    if (firstToken.includes("/")) return [];

    const {history, frequency} = historySnapshot();
    // 远端历史都是真实执行过的命令，排在本地草稿历史之前
    const remote = getRemoteHistory(sessionId);
    const candidates = remote.length > 0 ? [...remote, ...history] : history;
    const seen = new Set<string>();
    const results: CommandSuggestion[] = [];

    const ranked = candidates
        .map((text, index) => ({text, index}))
        .filter((item) => item.text.startsWith(line) && item.text !== line)
        .sort((a, b) => (frequency[b.text] ?? 0) - (frequency[a.text] ?? 0) || a.index - b.index);

    for (const item of ranked) {
        if (seen.has(item.text)) continue;
        seen.add(item.text);
        results.push({text: item.text, source: "history"});
        if (results.length >= limit) return results;
    }

    if (!/\s/.test(line) && firstToken.length >= 2) {
        for (const command of BUILTIN_COMMANDS) {
            if (!command.startsWith(line) || command === line || seen.has(command)) continue;
            results.push({text: command, source: "builtin"});
            if (results.length >= limit) break;
        }
    }
    return results;
}

/**
 * 构造接受建议需要发送的按键序列：
 * 用退格删掉已输入部分，再补上建议剩余内容。
 * 当前行与建议不匹配（输入已变化）时返回空字符串。
 */
export function buildSuggestionInput(line: string, suggestion: string): string {
    if (!suggestion.startsWith(line)) return "";
    const typedChars = [...line].length;
    const suffix = suggestion.slice(line.length);
    if (typedChars === 0 && !suffix) return "";
    return "\u007f".repeat(typedChars) + suffix;
}
