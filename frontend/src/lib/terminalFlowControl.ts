// 终端流控背压 + 滚动锚定工具
// 借鉴 Tabby 的 XTermFrontend 实现，防止高速输出压垮渲染线程

import type { Terminal } from "@xterm/xterm";

// 流控参数
const MAX_CHAIN_DEPTH = 20; // 待处理写入超过此数时背压等待

/**
 * 创建带背压控制的写入器
 *
 * 核心设计：Promise 链序列化
 * - 每次 write() 都链在上一次 write 之后，保证数据顺序
 * - 链深度超过阈值时，调用方 await 等待前面写入完成（背压）
 * - xterm.write 的 callback 在渲染完成后触发，自然限速
 */
export function createFlowControlledWriter(term: Terminal) {
    let writeChain: Promise<void> = Promise.resolve();
    let chainDepth = 0;

    async function write(data: string | Uint8Array): Promise<void> {
        // 背压：链深度超过阈值时等待前面的写入完成
        if (chainDepth >= MAX_CHAIN_DEPTH) {
            await writeChain.catch(() => {});
        }

        chainDepth++;
        writeChain = writeChain
            .then(
                () =>
                    new Promise<void>((resolve) => {
                        try {
                            term.write(data, () => {
                                chainDepth--;
                                resolve();
                            });
                        } catch {
                            // 终端可能已销毁，安全跳过
                            chainDepth--;
                            resolve();
                        }
                    }),
            )
            .catch(() => {}); // 确保链不会因错误中断

        return writeChain;
    }

    function reset(): void {
        chainDepth = 0;
        writeChain = Promise.resolve();
    }

    return { write, reset };
}

/**
 * 滚动锚定：用户上滑查看历史时，新数据到来不强制拉回底部
 *
 * 实现：
 * 1. patch 掉 xterm 原生 scrollToBottom 为 no-op
 * 2. 通过 term.onScroll 追踪视口位置（覆盖 wheel、键盘、滚动条等所有来源）
 * 3. 提供 shouldScrollToBottom() 供写入方在写后调用
 */
export function setupScrollAnchoring(term: Terminal, container: HTMLElement): {
    cleanup: () => void;
    shouldScrollToBottom: () => boolean;
    forceScrollToBottom: () => void;
} {
    let pinnedToBottom = true;

    // @ts-ignore - 访问 xterm 内部 _core
    const xtermCore = term._core;
    if (!xtermCore) {
        return { cleanup: () => {}, shouldScrollToBottom: () => true, forceScrollToBottom: () => {} };
    }

    // 保存原始 scrollToBottom 并 patch 为 no-op
    const originalScrollToBottom = xtermCore.scrollToBottom?.bind(xtermCore);
    xtermCore.scrollToBottom = () => {};

    // 使用 xterm 的 onScroll 事件追踪滚动位置
    // 覆盖所有滚动来源：wheel、键盘（PageUp/Down、方向键）、滚动条拖拽
    const scrollDisposable = term.onScroll((ydisp: number) => {
        pinnedToBottom = ydisp + term.rows >= term.buffer.active.length;
    });

    return {
        cleanup: () => {
            scrollDisposable.dispose();
            if (xtermCore.scrollToBottom !== undefined) {
                xtermCore.scrollToBottom = originalScrollToBottom;
            }
        },
        shouldScrollToBottom: () => pinnedToBottom,
        forceScrollToBottom: () => {
            pinnedToBottom = true;
            if (originalScrollToBottom) originalScrollToBottom();
        },
    };
}
