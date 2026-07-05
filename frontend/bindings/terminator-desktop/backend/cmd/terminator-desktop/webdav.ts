// WebDAVService 前端 binding
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

/** 测试 WebDAV 连接 */
export function TestWebDAVConnection(url: string, username: string, password: string): $CancellablePromise<void> {
    return $Call.ByID(3603204195, url, username, password);
}

/** 保存 WebDAV 配置，同时切换同步方式为 webdav */
export function SaveWebDAVConfig(url: string, username: string, password: string): $CancellablePromise<void> {
    return $Call.ByID(828045800, url, username, password);
}

/** 获取 WebDAV 配置（不返回密码） */
export function GetWebDAVConfig(): $CancellablePromise<[string, string]> {
    return $Call.ByID(1371291749);
}
