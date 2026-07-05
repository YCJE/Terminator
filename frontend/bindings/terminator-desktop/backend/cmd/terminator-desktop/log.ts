// LogService 前端 binding — 读取和清除应用日志
// 使用 Call.ByName 避免哈希计算错误
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

const PREFIX = "terminator-desktop/backend/cmd/terminator-desktop.LogService.";

/** 读取日志文件内容，返回最后 maxLines 行 */
export function GetLogs(maxLines: number): $CancellablePromise<string> {
    return $Call.ByName(PREFIX + "GetLogs", maxLines);
}

/** 清空日志文件 */
export function ClearLogs(): $CancellablePromise<void> {
    return $Call.ByName(PREFIX + "ClearLogs");
}
