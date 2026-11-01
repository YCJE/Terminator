/**
 * zmodem.js 没有官方类型定义，这里只声明本项目实际使用的 API。
 */
declare module "zmodem.js" {
    export interface ZmodemDetection {
        get_session_role(): "receive" | "send";
        is_valid(): boolean;
        confirm(): ZmodemSession;
        deny(): void;
    }

    export interface ZmodemOffer {
        get_details(): { name?: string; size?: number; mtime?: number; mode?: number };
        accept(opts?: { on_input?: string | ((payload: number[]) => void) }): Promise<Uint8Array[]>;
        skip(): Promise<void>;
    }

    export interface ZmodemTransfer {
        send(bytes: Uint8Array): void;
        end(bytes: Uint8Array): Promise<void>;
    }

    export interface ZmodemSession {
        type: "receive" | "send";
        on(event: "offer", handler: (offer: ZmodemOffer) => void): void;
        on(event: "session_end" | "garbage", handler: (...args: unknown[]) => void): void;
        start(): Promise<unknown>;
        send_offer(params: {
            name: string;
            size?: number;
            mtime?: number;
            mode?: number;
            files_remaining?: number;
            bytes_remaining?: number;
        }): Promise<ZmodemTransfer | undefined>;
        close(): Promise<void>;
        abort(): void;
        has_ended(): boolean;
    }

    export interface ZmodemSentryOptions {
        /** 非 ZMODEM 协议数据：原样写回终端 */
        to_terminal: (octets: ArrayLike<number>) => void;
        /** ZMODEM 协议数据：发送给远端 */
        sender: (octets: ArrayLike<number>) => void;
        on_detect: (detection: ZmodemDetection) => void;
        on_retract: () => void;
    }

    export class ZmodemSentry {
        constructor(options: ZmodemSentryOptions);
        consume(input: Uint8Array | number[]): void;
        get_confirmed_session(): ZmodemSession | null;
    }

    const Zmodem: { Sentry: typeof ZmodemSentry };
    export default Zmodem;
}
