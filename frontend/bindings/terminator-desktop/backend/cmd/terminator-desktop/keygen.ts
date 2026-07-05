// KeyGenService 前端 binding — 生成 SSH 密钥对
// 使用 Call.ByName 避免哈希计算错误
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

const PREFIX = "terminator-desktop/backend/cmd/terminator-desktop.KeyGenService.";

/**
 * 生成 SSH 私钥
 * @param keyType "ed25519" 或 "rsa"
 * @param rsaBits RSA 位数（2048/4096），Ed25519 忽略
 * @returns OpenSSH 格式 PEM 私钥
 */
export function GenerateKey(keyType: string, rsaBits: number): $CancellablePromise<string> {
    return $Call.ByName(PREFIX + "GenerateKey", keyType, rsaBits);
}
