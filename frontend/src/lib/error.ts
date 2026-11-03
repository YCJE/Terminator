import { toast } from "sonner";
import i18n from "@/i18n";
import { ErrorCode } from "@/lib/errorCodes";

export interface ApiErrorDetail {
    code: string;
    message: string;
}

export interface AppClientError {
    code: ErrorCode | string;
    message: string;
    detailsString?: string;
    detailsObject?: string;
    apiDetails?: ApiErrorDetail[];
    raw?: unknown;
}

/** 递归深度上限，防止循环引用导致栈溢出 */
const MAX_RECURSION_DEPTH = 5;

export function parseAppError(error: unknown): AppClientError {
    const fallback: AppClientError = {
        code: ErrorCode.UNKNOWN_ERROR,
        message: "Unknown error",
        raw: error,
    };

    if (!error) return fallback;

    const mapRawError = (rawCause: any, originalPayload: unknown, depth: number = 0): AppClientError => {
        // 深度保护：超过上限直接返回 fallback，防止循环引用死循环
        if (depth >= MAX_RECURSION_DEPTH) {
            return fallback;
        }

        if (rawCause && typeof rawCause === "object") {
            if (rawCause.Code) { // app error
                return {
                    code: rawCause.Code,
                    message: rawCause.Message || "App Error",
                    detailsString: rawCause.ErrorString,
                    detailsObject: rawCause.Err,
                    raw: originalPayload,
                };
            }
            if (rawCause.StatusCode) { // api error
                const details = Array.isArray(rawCause.Details)
                    ? rawCause.Details as ApiErrorDetail[]
                    : [];

                return {
                    code: ErrorCode.API_ERROR,
                    message: "API Error",
                    apiDetails: details,
                    raw: originalPayload,
                };
            }
            if (rawCause.error) { // emitter error
                // error 字段可能是字符串（如 EmitSyncError 的 Err string）或对象
                if (typeof rawCause.error === "string") {
                    return {
                        code: ErrorCode.INTERNAL_ERROR,
                        message: rawCause.error,
                        raw: originalPayload,
                    };
                }
                return mapRawError(rawCause.error, originalPayload, depth + 1)
            }
        }
        return fallback;
    };

    // we got this from an emitter
    if (typeof error === "object" && "error" in error) {
        return mapRawError(error, error);
    }

    // we got this from wails
    let errorString = "";
    if (typeof error === "string") {
        errorString = error;
    } else if (error instanceof Error) {
        errorString = error.message;
    }

    if (errorString) {
        try {
            const parsed = JSON.parse(errorString);
            if (parsed?.cause) {
                const mapped = mapRawError(parsed.cause, parsed);
                // cause 无法识别（例如普通 Go error 序列化成空对象）时，
                // Wails 仍把原始错误文案放在 parsed.message 中，不能丢。
                if (mapped.code !== ErrorCode.UNKNOWN_ERROR) {
                    return mapped;
                }
            }
            if (typeof parsed?.message === "string" && parsed.message.trim()) {
                return { code: ErrorCode.INTERNAL_ERROR, message: parsed.message, raw: parsed };
            }
            // 有效 JSON 但无可用错误信息，保留原始字符串便于排查
            return { code: ErrorCode.INTERNAL_ERROR, message: errorString, raw: error };
        } catch {
            if (error instanceof Error) {
                return { code: ErrorCode.RUNTIME_ERROR, message: error.message, raw: error };
            }
            return { code: ErrorCode.INTERNAL_ERROR, message: errorString, raw: error };
        }
    }

    return fallback;
}

// 错误去抖：同一错误码在 5 秒内只弹窗一次
// 借鉴 Netcatty 的运行时保护窗口机制
const ERROR_DEBOUNCE_MS = 5000;
const recentErrors = new Map<string, number>();

function shouldShowError(errorCode: string, message: string): boolean {
    const now = Date.now();
    // 同一错误码下不同原因的失败不应互相吞掉：普通 Go error 全部归为
    // INTERNAL_ERROR，只按 code 去抖会让 5 秒内第二次失败的原始信息消失。
    const key = `${errorCode}:${message}`;
    const lastShown = recentErrors.get(key);
    if (lastShown && now - lastShown < ERROR_DEBOUNCE_MS) {
        return false; // 去抖窗口内，不重复弹窗
    }
    recentErrors.set(key, now);
    // 清理过期条目，防止 Map 无限增长
    if (recentErrors.size > 50) {
        for (const [key, ts] of recentErrors) {
            if (now - ts > ERROR_DEBOUNCE_MS) {
                recentErrors.delete(key);
            }
        }
    }
    return true;
}

export function handleAppError(rawError: unknown, fallbackCode: string = ErrorCode.UNKNOWN_ERROR) {
    const appError = parseAppError(rawError);

    // 去抖检查：同一错误码 + 同一文案在保护窗口内不重复弹窗
    if (!shouldShowError(appError.code, appError.message)) {
        console.warn("Suppressed duplicate error:", { code: appError.code });
        return;
    }

    const safeTitle = i18n.t(`errors:${appError.code}`, {
        defaultValue: i18n.t(`errors:${fallbackCode}`),
    });

    let description: string | undefined = undefined;

    if (appError.code === ErrorCode.API_ERROR && appError.apiDetails && appError.apiDetails.length > 0) {
        description = appError.apiDetails
            .map((detail) => i18n.t(`errors:${detail.code}`, { defaultValue: detail.code }))
            .join(" • ");
    } else if (appError.code === ErrorCode.API_ERROR) {
        description = i18n.t(`errors:${ErrorCode.INTERNAL_ERROR}`);
    } else if (appError.detailsString) {
        description = appError.detailsString;
    } else if (appError.message && appError.message !== "Unknown error") {
        // 没有结构化详情时至少展示底层错误文案：否则所有普通 error 都只显示
        // "未知错误"，用户看不到权限不足、路径不存在等真实原因。
        description = appError.message;
    }

    toast.error(safeTitle, {
        description: description,
        duration: 5000,
    });

    // 仅输出非敏感字段，避免密码/密钥泄露到控制台
    console.error("App Error:", { code: appError.code, message: appError.message });
}
