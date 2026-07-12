// SFTP 文件管理服务前端 binding
// 方法 ID 由 FNV-1a 哈希计算，与后端绑定的 methodID 一一对应

import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

/** 单个文件/目录条目信息 */
export interface FileEntry {
    name: string;
    size: number;
    mode: string;
    modTime: string;
    isDir: boolean;
    isSymlink: boolean;
}

/** 列出指定目录下的所有文件与子目录 */
export function ListDir(sessionId: string, path: string): $CancellablePromise<FileEntry[]> {
    return $Call.ByID(122728374, sessionId, path);
}

/** 读取小文件文本内容用于预览 */
export function ReadFile(sessionId: string, path: string): $CancellablePromise<string> {
    return $Call.ByID(872684653, sessionId, path);
}

/** 创建目录 */
export function Mkdir(sessionId: string, path: string): $CancellablePromise<void> {
    return $Call.ByID(3831651222, sessionId, path);
}

/** 删除文件或目录 */
export function Remove(sessionId: string, path: string): $CancellablePromise<void> {
    return $Call.ByID(2937593491, sessionId, path);
}

/** 重命名或移动文件/目录 */
export function Rename(sessionId: string, oldPath: string, newPath: string): $CancellablePromise<void> {
    return $Call.ByID(4146034469, sessionId, oldPath, newPath);
}

/** 修改文件/目录权限，mode 为八进制权限数值（如 0o755 = 493） */
export function Chmod(sessionId: string, path: string, mode: number): $CancellablePromise<void> {
    return $Call.ByID(1505661080, sessionId, path, mode);
}

/** 上传本地文件到远程路径，transferId 用于关联传输进度事件 */
export function UploadFile(sessionId: string, transferId: string, localPath: string, remotePath: string): $CancellablePromise<void> {
    return $Call.ByID(890062900, sessionId, transferId, localPath, remotePath);
}

/** 下载远程文件到本地路径，transferId 用于关联传输进度事件 */
export function DownloadFile(sessionId: string, transferId: string, remotePath: string, localPath: string): $CancellablePromise<void> {
    return $Call.ByID(3219845717, sessionId, transferId, remotePath, localPath);
}

/** 获取 SSH 会话的远端主目录路径 */
export function HomeDir(sessionId: string): $CancellablePromise<string> {
    return $Call.ByID(2880722651, sessionId);
}

/** 搜索结果条目，包含完整路径 */
export interface SearchResultEntry {
    path: string;
    name: string;
    size: number;
    isDir: boolean;
}

/** 递归搜索文件/目录，searchPath 为起始目录，query 为文件名关键词 */
export function SearchFiles(sessionId: string, searchPath: string, query: string, maxResults: number): $CancellablePromise<SearchResultEntry[]> {
    return $Call.ByID(2705080646, sessionId, searchPath, query, maxResults);
}

/** 写入文本内容到远程文件（覆盖写入），用于远程文件编辑保存 */
export function WriteFile(sessionId: string, path: string, content: string): $CancellablePromise<void> {
    return $Call.ByID(1521240084, sessionId, path, content);
}
