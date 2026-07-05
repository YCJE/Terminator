// LogService 前端 binding — 读取和清除应用日志
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

/** 读取日志文件内容，返回最后 maxLines 行 */
export function GetLogs(maxLines: number): $CancellablePromise<string> {
    return $Call.ByID(2232439488, maxLines);
}

/** 清空日志文件 */
export function ClearLogs(): $CancellablePromise<void> {
    return $Call.ByID(2886546173);
}
