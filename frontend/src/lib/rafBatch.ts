// RAF 批量合并工具
// 借鉴 Netcatty 的模块级单例 Store + useSyncExternalStore + RAF merge 模式
// 同一帧内的多次回调在下一个 RAF 中批量执行，避免渲染抖动

let scheduledFns: Array<() => void> = [];
let rafId: number | null = null;

/**
 * 将回调调度到下一个 requestAnimationFrame 中执行
 * 同一帧内多次调用的所有回调都会在 RAF 中依次执行（不会丢失中间更新）
 */
export function scheduleRAF(fn: () => void): void {
    scheduledFns.push(fn);
    if (!rafId) {
        rafId = requestAnimationFrame(() => {
            rafId = null;
            const fns = scheduledFns;
            scheduledFns = [];
            for (const f of fns) {
                try {
                    f();
                } catch (e) {
                    console.error("RAF batch callback error:", e);
                }
            }
        });
    }
}

/**
 * 取消所有待执行的 RAF 回调
 */
export function cancelRAF(): void {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    scheduledFns = [];
}

/**
 * 创建一个 RAF 调度的 store 订阅器
 * 用于 Zustand store 的高频更新场景
 *
 * 用法：
 * ```ts
 * const subscribeWithRAF = createRAFSubscriber(useSessionStore);
 * // 在组件中使用
 * subscribeWithRAF((state) => { ... });
 * ```
 */
export function createRAFSubscriber<T>(store: {
    subscribe: (listener: (state: T) => void) => () => void;
    getState: () => T;
}) {
    return (listener: (state: T) => void) => {
        return store.subscribe((state) => {
            scheduleRAF(() => listener(state));
        });
    };
}
