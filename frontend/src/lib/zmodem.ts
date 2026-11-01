import Zmodem, { type ZmodemDetection, type ZmodemSentry } from "zmodem.js";

/** 单个待上传文件：字节内容已在内存中（ZMODEM 上传要求先知道文件大小） */
export interface ZmodemUploadFile {
    name: string;
    bytes: Uint8Array;
}

/** 传输过程中的状态事件，由 UI 层翻译成提示文案 */
export type ZmodemEvent =
    | { kind: "download-start"; name: string; size: number }
    | { kind: "download-done"; name: string; size: number }
    | { kind: "download-skipped"; name: string }
    | { kind: "upload-start"; count: number }
    | { kind: "upload-done"; count: number; skipped: number }
    | { kind: "canceled" };

export interface ZmodemHooks {
    /** 非协议数据写回终端 */
    writeToTerminal: (bytes: Uint8Array) => void;
    /** 协议数据发送给远端（base64，避免 Wails 字符串传输破坏二进制） */
    sendToRemote: (bytesBase64: string) => void;
    /** 下载时询问本地保存路径；返回 null 表示用户取消 */
    pickSavePath: (suggestedName: string) => Promise<string | null>;
    /** 把收到的字节写入本地文件 */
    saveBinary: (path: string, contentBase64: string) => Promise<void>;
    onEvent: (event: ZmodemEvent) => void;
    onError: (message: string) => void;
}

/** 单个文件上限：与后端 ReadBinary/SaveBinary 的 128MB 上限一致 */
const MAX_FILE_BYTES = 128 << 20;
/** 发出 rz 后退远未开始传输的最长等待时间 */
const UPLOAD_TIMEOUT_MS = 20_000;

function encodeBase64(bytes: ArrayLike<number>): string {
    let binary = "";
    // 分段拼接：一次性 spread 整个数组会触发参数数量上限
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...Array.prototype.slice.call(bytes, i, i + chunk));
    }
    return btoa(binary);
}

function encodeBytesToBase64(bytes: Uint8Array): string {
    return encodeBase64(bytes);
}

/** 取文件名最后一段并剔除路径分隔符/控制字符，避免收到 `../../x` 之类路径 */
function safeBaseName(raw?: string): string {
    const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
    return cleaned || "zmodem-file";
}

/**
 * ZMODEM 桥接器：把终端字节流交给 zmodem.js 检测/协商，
 * 协议数据直接发往远端，普通数据仍写回终端。
 *
 * 下载（远端 sz）：自动检测 ZRQINIT → 立即接受并缓存数据 → 询问保存路径 → 写盘。
 * 上传（远端 rz）：需要先调用 queueUpload 选定文件，再由界面发送 rz 命令；
 * 检测到 ZRINIT 后逐个 offer 并传输。
 */
export class ZmodemBridge {
    private readonly hooks: ZmodemHooks;
    private readonly sentry: ZmodemSentry;
    private pending: { files: ZmodemUploadFile[]; timer: ReturnType<typeof setTimeout> } | null = null;
    private session: any = null;
    // 下载保存串行化：多个文件依次弹保存框，避免同时打开多个系统对话框
    private saveChain: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(hooks: ZmodemHooks) {
        this.hooks = hooks;
        this.sentry = new Zmodem.Sentry({
            to_terminal: (octets) => {
                if (!this.disposed) this.hooks.writeToTerminal(new Uint8Array(octets));
            },
            sender: (octets) => {
                if (!this.disposed) this.hooks.sendToRemote(encodeBase64(octets));
            },
            on_detect: (detection) => this.handleDetect(detection),
            on_retract: () => {},
        });
    }

    /** 送入终端输出字节；非 ZMODEM 数据会自动写回终端 */
    consume(bytes: Uint8Array): void {
        if (this.disposed) return;
        this.sentry.consume(bytes);
    }

    /** 登记待上传文件；调用方随后应在终端执行 rz */
    queueUpload(files: ZmodemUploadFile[]): void {
        if (this.session) {
            this.hooks.onError("当前已有 ZMODEM 传输进行中");
            return;
        }
        this.clearPending();
        const timer = setTimeout(() => {
            this.pending = null;
            if (!this.disposed) {
                this.hooks.onError("等待远端 rz 超时，请确认服务器已安装 lrzsz");
            }
        }, UPLOAD_TIMEOUT_MS);
        this.pending = {files, timer};
        this.hooks.onEvent({kind: "upload-start", count: files.length});
    }

    isActive(): boolean {
        return this.session !== null;
    }

    hasPendingUpload(): boolean {
        return this.pending !== null;
    }

    /** 用户主动中止（Esc）：终结协议并把控制权交回终端 */
    abort(): void {
        this.clearPending();
        const session = this.session;
        this.session = null;
        if (session) {
            try {
                session.abort();
            } catch {
                // 会话可能已结束，忽略
            }
            this.hooks.onEvent({kind: "canceled"});
        }
    }

    dispose(): void {
        this.disposed = true;
        this.clearPending();
        this.session = null;
    }

    private clearPending(): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
        }
    }

    private handleDetect(detection: ZmodemDetection): void {
        let session: any;
        try {
            session = detection.confirm();
        } catch {
            return; // 检测已失效，按普通输出处理
        }
        const role = detection.get_session_role();

        if (role === "receive") {
            this.startReceive(session);
            return;
        }

        // 远端执行了 rz，需要本地作为发送方；没有预选文件时中止会话
        const pending = this.pending;
        if (!pending) {
            try {
                session.abort();
            } catch {
                // ignore
            }
            this.hooks.onError("远端已启动 rz，请先通过菜单选择要上传的文件");
            return;
        }
        clearTimeout(pending.timer);
        this.pending = null;
        this.session = session;
        void this.sendFiles(session, pending.files);
    }

    private startReceive(session: any): void {
        this.session = session;
        session.on("offer", (offer: any) => this.handleOffer(offer));
        session.on("session_end", () => this.finishSession());
        session.start().catch((err: unknown) => {
            this.hooks.onError(errorText(err));
            this.finishSession();
        });
    }

    private handleOffer(offer: any): void {
        const details = offer.get_details?.() ?? {};
        const name = safeBaseName(details.name);
        const size = Number(details.size) || 0;

        if (size > MAX_FILE_BYTES) {
            try {
                offer.skip();
            } catch {
                // ignore
            }
            this.hooks.onEvent({kind: "download-skipped", name});
            this.hooks.onError(`${name} 超过 ${MAX_FILE_BYTES >> 20} MB 上限，已跳过`);
            return;
        }

        this.hooks.onEvent({kind: "download-start", name, size});
        // 立即接受：发送端在等待 ZRPOS，不能先等用户选完保存路径
        const accepted = offer.accept();
        accepted.catch((err: unknown) => this.hooks.onError(errorText(err)));

        this.saveChain = this.saveChain.then(async () => {
            // 会话/终端已关闭：不再弹保存框，也不写盘
            if (this.disposed) return;
            const path = await this.hooks.pickSavePath(name);
            if (!path) {
                this.hooks.onEvent({kind: "download-skipped", name});
                return;
            }
            const payloads = (await accepted) as Uint8Array[];
            const bytes = concatPayloads(payloads);
            if (bytes.length > MAX_FILE_BYTES) {
                this.hooks.onError(`${name} 超过 ${MAX_FILE_BYTES >> 20} MB 上限，已丢弃`);
                return;
            }
            await this.hooks.saveBinary(path, encodeBytesToBase64(bytes));
            this.hooks.onEvent({kind: "download-done", name, size: bytes.length});
        }).catch((err: unknown) => {
            this.hooks.onError(errorText(err));
        });
    }

    private async sendFiles(session: any, files: ZmodemUploadFile[]): Promise<void> {
        let sent = 0;
        let skipped = 0;
        try {
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                if (file.bytes.length > MAX_FILE_BYTES) {
                    skipped++;
                    this.hooks.onError(`${file.name} 超过 ${MAX_FILE_BYTES >> 20} MB 上限，已跳过`);
                    continue;
                }
                let remaining = 0;
                for (let i = index; i < files.length; i++) remaining += files[i].bytes.length;

                const transfer = await session.send_offer({
                    name: file.name,
                    size: file.bytes.length,
                    mtime: Math.floor(Date.now() / 1000),
                    mode: 0o644,
                    files_remaining: files.length - index,
                    bytes_remaining: remaining,
                });
                if (!transfer) {
                    skipped++;
                    continue; // 接收方选择跳过该文件
                }
                // end() 内部按 8KB 子包切分；空文件也会发送空数据包
                await transfer.end(file.bytes);
                sent++;
            }
            await session.close();
            this.hooks.onEvent({kind: "upload-done", count: sent, skipped});
        } catch (err) {
            this.hooks.onError(errorText(err));
            try {
                session.abort();
            } catch {
                // ignore
            }
        } finally {
            this.finishSession();
        }
    }

    private finishSession(): void {
        if (this.session) {
            this.session = null;
        }
    }
}

function concatPayloads(payloads: Uint8Array[]): Uint8Array {
    const total = payloads.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const payload of payloads) {
        out.set(payload, offset);
        offset += payload.length;
    }
    return out;
}

function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}
