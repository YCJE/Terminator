import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

/**
 * Normalises a user-entered server URL to a fully-qualified
 * `https://<host>/api/v1` endpoint.
 *
 * - Prepends `https://` when no recognised scheme is present.
 * - Accepts `http://` only as-is (for local dev servers).
 * - Strips trailing slashes and appends `/api/v1` when missing.
 * - Removes query/hash before the path check to avoid malformed results.
 */
export function formatServerUrl(inputUrl: string): string {
    let cleanUrl = inputUrl.trim();

    const lower = cleanUrl.toLowerCase();
    const hasScheme = lower.startsWith("https://") || lower.startsWith("http://");

    if (!hasScheme) {
        cleanUrl = `https://${cleanUrl}`;
    }

    // 校验 URL 合法性：hostname 非空且协议为 http/https
    try {
        const parsed = new URL(cleanUrl);
        if (!parsed.hostname) {
            throw new Error("missing hostname");
        }
    } catch {
        throw new Error("invalid server URL");
    }

    // Strip query/hash for the /api/v1 suffix check, then re-attach.
    const qIdx = cleanUrl.search(/[?#]/);
    let query = "";
    if (qIdx >= 0) {
        query = cleanUrl.slice(qIdx);
        cleanUrl = cleanUrl.slice(0, qIdx);
    }

    // Strip trailing slash first, then check for /api/v1 suffix
    cleanUrl = cleanUrl.replace(/\/+$/, "");
    if (!cleanUrl.endsWith("/api/v1")) {
        cleanUrl = `${cleanUrl}/api/v1`;
    }

    return cleanUrl + query;
}

export function decodeBase64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    return Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
}
