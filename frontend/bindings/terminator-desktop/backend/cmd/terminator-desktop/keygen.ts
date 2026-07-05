// 密钥生成功能已合并到 KeyService
// 使用 KeyService.GenerateKey
import { Call as $Call, CancellablePromise as $CancellablePromise } from "@wailsio/runtime";

/**
 * 生成 SSH 私钥
 * @param keyType "ed25519" 或 "rsa"
 * @param rsaBits RSA 位数（2048/4096），Ed25519 忽略
 * @returns OpenSSH 格式 PEM 私钥
 */
export function GenerateKey(keyType: string, rsaBits: number): $CancellablePromise<string> {
    return $Call.ByID(402982813, keyType, rsaBits);
}
