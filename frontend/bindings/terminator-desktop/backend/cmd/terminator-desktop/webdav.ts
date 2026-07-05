// WebDAVService 前端 binding
// 使用 Call.ByName 避免哈希计算错误
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

const PREFIX = "terminator-desktop/backend/cmd/terminator-desktop.WebDAVService.";

/** 测试 WebDAV 连接 */
export function TestWebDAVConnection(url: string, username: string, password: string): $CancellablePromise<void> {
    return $Call.ByName(PREFIX + "TestWebDAVConnection", url, username, password);
}

/** 保存 WebDAV 配置，同时切换同步方式为 webdav */
export function SaveWebDAVConfig(url: string, username: string, password: string): $CancellablePromise<void> {
    return $Call.ByName(PREFIX + "SaveWebDAVConfig", url, username, password);
}

/** 获取 WebDAV 配置（不返回密码） */
export function GetWebDAVConfig(): $CancellablePromise<[string, string]> {
    return $Call.ByName(PREFIX + "GetWebDAVConfig");
}
