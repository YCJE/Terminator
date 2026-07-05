// 日志功能已合并到 SettingsService
// 使用 SettingsService.GetLogs 和 SettingsService.ClearLogs
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

/** 读取日志文件内容，返回最后 maxLines 行 */
export function GetLogs(maxLines: number): $CancellablePromise<string> {
    return $Call.ByID(3313034702, maxLines);
}

/** 清空日志文件 */
export function ClearLogs(): $CancellablePromise<void> {
    return $Call.ByID(648462599);
}
