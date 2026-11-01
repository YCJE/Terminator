// 传输并发调度：同一个 SSH 会话最多同时执行 3 个传输任务，其余排队。
//
// sftp 客户端共享同一条 SSH 连接，同时发起几十个传输会让通道排队、
// 进度事件互相挤占，整体速度反而更慢。这里按会话做简单的并发上限，
// 队列中的任务在传输面板里显示为"排队中"，开始执行前不会触碰后端。

const MAX_CONCURRENT_PER_SESSION = 3;

interface QueueEntry {
    id: string;
    run: () => Promise<void>;
    /** 排队期间被取消时的回调：让等待该任务的调用方得以结束 */
    onCancel?: () => void;
}

interface SessionQueue {
    active: number;
    pending: QueueEntry[];
}

const queues = new Map<string, SessionQueue>();

function ensureQueue(sessionId: string): SessionQueue {
    const existing = queues.get(sessionId);
    if (existing) return existing;
    const queue: SessionQueue = {active: 0, pending: []};
    queues.set(sessionId, queue);
    return queue;
}

function startEntry(sessionId: string, queue: SessionQueue, entry: QueueEntry): void {
    queue.active++;
    // run 内部负责把错误写回传输队列，这里只保证槽位最终释放
    void entry.run()
        .catch(() => {})
        .finally(() => {
            queue.active--;
            const next = queue.pending.shift();
            if (next) {
                startEntry(sessionId, queue, next);
                return;
            }
            if (queue.active === 0) queues.delete(sessionId);
        });
}

/**
 * 把任务加入调度队列。
 * run 必须自行捕获错误并更新传输队列状态；本函数不感知任务成败。
 */
export function scheduleTransfer(
    sessionId: string,
    id: string,
    run: () => Promise<void>,
    onCancel?: () => void,
): void {
    const queue = ensureQueue(sessionId);
    const entry: QueueEntry = {id, run, onCancel};
    if (queue.active >= MAX_CONCURRENT_PER_SESSION) {
        queue.pending.push(entry);
        return;
    }
    startEntry(sessionId, queue, entry);
}

/** 取消一个仍在排队的任务；已开始执行的任务返回 false（应由 CancelTransfer 处理） */
export function cancelScheduledTransfer(sessionId: string, id: string): boolean {
    const queue = queues.get(sessionId);
    if (!queue) return false;
    const index = queue.pending.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [removed] = queue.pending.splice(index, 1);
    removed?.onCancel?.();
    if (queue.active === 0 && queue.pending.length === 0) queues.delete(sessionId);
    return true;
}

/** 会话断开/关闭时丢弃该会话的排队任务，避免之后对已失效会话发起传输 */
export function clearScheduledTransfers(sessionId: string): void {
    const queue = queues.get(sessionId);
    if (queue) {
        for (const entry of queue.pending) entry.onCancel?.();
    }
    queues.delete(sessionId);
}
