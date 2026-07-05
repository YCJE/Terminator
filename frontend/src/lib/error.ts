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
                return mapRawError(parsed.cause, parsed);
            }
            // 有效 JSON 但无 cause 字段，保留原始字符串作为错误信息
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

export function handleAppError(rawError: unknown, fallbackCode: string = ErrorCode.UNKNOWN_ERROR) {
    const appError = parseAppError(rawError);

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
    }

    toast.error(safeTitle, {
        description: description,
        duration: 5000,
    });

    // 仅输出非敏感字段，避免密码/密钥泄露到控制台
    console.error("App Error:", { code: appError.code, message: appError.message });
}
