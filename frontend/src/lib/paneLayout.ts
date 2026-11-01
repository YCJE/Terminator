// 终端窗格布局树：支持任意方向的嵌套分屏（最多 4 个窗格）。
//
// 与旧版"一组固定左右/上下分屏"不同，这里用二叉布局树表示：
// 每个 split 节点记录方向与分割比例，叶子节点引用一个会话 ID。
// 所有函数均为纯函数，便于在 store、快照恢复与渲染层之间共享。

import type { SplitOrientation } from "@/store/sessionStore";

/** 单次布局最多允许的窗格数：超过后布局与终端尺寸都会难以使用 */
export const MAX_PANES = 4;

/** 分割比例的安全范围：任一侧都不小于 15% */
export const MIN_PANE_RATIO = 0.15;
export const MAX_PANE_RATIO = 0.85;

export type PaneLayoutNode =
    | { kind: "leaf"; sessionId: string }
    | {
        kind: "split";
        /** 节点稳定 ID：用于拖动分隔条时精确定位到该节点 */
        id: string;
        orientation: SplitOrientation;
        /** 第一个子节点占整体尺寸的比例 */
        ratio: number;
        first: PaneLayoutNode;
        second: PaneLayoutNode;
    };

/** 布局矩形（百分比，相对终端容器），用于渲染各窗格与分隔条 */
export interface PaneRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** 分隔条渲染信息：所属 split 节点 + 自身矩形 + 方向 + 比例 */
export interface PaneDivider {
    nodeId: string;
    orientation: SplitOrientation;
    ratio: number;
    rect: PaneRect;
}

/** 布局快照形状：叶子记为 null，split 节点记录方向/比例与两个子树 */
export interface PaneShapeSnapshot {
    orientation: SplitOrientation;
    ratio: number;
    first: PaneShapeSnapshot | null;
    second: PaneShapeSnapshot | null;
}

export function makePaneLeaf(sessionId: string): PaneLayoutNode {
    return { kind: "leaf", sessionId };
}

export function makePaneSplit(
    orientation: SplitOrientation,
    first: PaneLayoutNode,
    second: PaneLayoutNode,
    ratio = 0.5,
    id = crypto.randomUUID(),
): PaneLayoutNode {
    return {
        kind: "split",
        id,
        orientation,
        ratio: clampPaneRatio(ratio),
        first,
        second,
    };
}

export function clampPaneRatio(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0.5;
    return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

/** 收集布局中的全部会话 ID（深度优先，第一个即标签页代表会话） */
export function collectPaneSessionIds(node: PaneLayoutNode | null): string[] {
    if (!node) return [];
    if (node.kind === "leaf") return [node.sessionId];
    return [...collectPaneSessionIds(node.first), ...collectPaneSessionIds(node.second)];
}

export function isPaneSession(node: PaneLayoutNode | null, sessionId: string): boolean {
    if (!node) return false;
    if (node.kind === "leaf") return node.sessionId === sessionId;
    return isPaneSession(node.first, sessionId) || isPaneSession(node.second, sessionId);
}

/** 布局的代表会话（第一个叶子）：标签栏用它高亮所属标签 */
export function firstPaneSession(node: PaneLayoutNode | null): string | null {
    if (!node) return null;
    if (node.kind === "leaf") return node.sessionId;
    return firstPaneSession(node.first) ?? firstPaneSession(node.second);
}

export function countPanes(node: PaneLayoutNode | null): number {
    if (!node) return 0;
    if (node.kind === "leaf") return 1;
    return countPanes(node.first) + countPanes(node.second);
}

/** 把指定叶子替换为新的子树；未命中时返回原树（replaced=false） */
export function replacePaneLeaf(
    node: PaneLayoutNode,
    sessionId: string,
    build: (leaf: PaneLayoutNode) => PaneLayoutNode,
): { node: PaneLayoutNode; replaced: boolean } {
    if (node.kind === "leaf") {
        if (node.sessionId !== sessionId) return {node, replaced: false};
        return {node: build(node), replaced: true};
    }
    const first = replacePaneLeaf(node.first, sessionId, build);
    if (first.replaced) {
        return {node: {...node, first: first.node}, replaced: true};
    }
    const second = replacePaneLeaf(node.second, sessionId, build);
    if (second.replaced) {
        return {node: {...node, second: second.node}, replaced: true};
    }
    return {node, replaced: false};
}

/**
 * 从布局中移除一个叶子。
 * 返回新的布局（可能在只剩一个叶子时坍缩为 null，或把兄弟子树提升一级）。
 */
export function removePaneLeaf(
    node: PaneLayoutNode,
    sessionId: string,
): { node: PaneLayoutNode | null; removed: boolean } {
    if (node.kind === "leaf") {
        return node.sessionId === sessionId
            ? {node: null, removed: true}
            : {node, removed: false};
    }
    const first = removePaneLeaf(node.first, sessionId);
    if (first.removed) {
        return {node: first.node ?? node.second, removed: true};
    }
    const second = removePaneLeaf(node.second, sessionId);
    if (second.removed) {
        return {node: second.node ?? node.first, removed: true};
    }
    return {node, removed: false};
}

/** 更新指定 split 节点的分割比例 */
export function setPaneNodeRatio(node: PaneLayoutNode, nodeId: string, ratio: number): PaneLayoutNode {
    if (node.kind === "leaf") return node;
    if (node.id === nodeId) {
        return {...node, ratio: clampPaneRatio(ratio)};
    }
    return {
        ...node,
        first: setPaneNodeRatio(node.first, nodeId, ratio),
        second: setPaneNodeRatio(node.second, nodeId, ratio),
    };
}

/** 计算每个叶子的矩形区域与所有分隔条的渲染信息 */
export function computePaneLayout(node: PaneLayoutNode | null): {
    leaves: Map<string, PaneRect>;
    dividers: PaneDivider[];
} {
    const leaves = new Map<string, PaneRect>();
    const dividers: PaneDivider[] = [];
    if (!node) return {leaves, dividers};

    const full: PaneRect = {left: 0, top: 0, width: 100, height: 100};
    const walk = (current: PaneLayoutNode, rect: PaneRect) => {
        if (current.kind === "leaf") {
            leaves.set(current.sessionId, rect);
            return;
        }
        dividers.push({
            nodeId: current.id,
            orientation: current.orientation,
            ratio: current.ratio,
            rect,
        });
        if (current.orientation === "row") {
            const firstWidth = rect.width * current.ratio;
            walk(current.first, {...rect, width: firstWidth});
            walk(current.second, {
                left: rect.left + firstWidth,
                top: rect.top,
                width: rect.width - firstWidth,
                height: rect.height,
            });
            return;
        }
        const firstHeight = rect.height * current.ratio;
        walk(current.first, {...rect, height: firstHeight});
        walk(current.second, {
            left: rect.left,
            top: rect.top + firstHeight,
            width: rect.width,
            height: rect.height - firstHeight,
        });
    };
    walk(node, full);
    return {leaves, dividers};
}

/** 把布局树压成可持久化的形状（叶子为 null） */
export function capturePaneShape(node: PaneLayoutNode | null): PaneShapeSnapshot | null {
    if (!node || node.kind === "leaf") return null;
    return {
        orientation: node.orientation,
        ratio: node.ratio,
        first: capturePaneShape(node.first),
        second: capturePaneShape(node.second),
    };
}

/** 校验来自 localStorage 的快照形状；非法时返回 null */
export function parsePaneShape(value: unknown): PaneShapeSnapshot | null {
    if (!value || typeof value !== "object") return null;
    const shape = value as Partial<PaneShapeSnapshot>;
    if (shape.orientation !== "row" && shape.orientation !== "column") return null;
    const ratio = typeof shape.ratio === "number" ? clampPaneRatio(shape.ratio) : 0.5;
    const first = shape.first === null ? null : parsePaneShape(shape.first);
    const second = shape.second === null ? null : parsePaneShape(shape.second);
    // 只有一侧子树缺失时视为非法：避免恢复出单边分屏
    if ((first === null) !== (second === null)) return null;
    return {orientation: shape.orientation, ratio, first, second};
}

/** 形状对应的窗格数量 */
export function countPaneShape(shape: PaneShapeSnapshot | null): number {
    if (!shape) return 1;
    return countPaneShape(shape.first) + countPaneShape(shape.second);
}

/**
 * 按形状构建布局树：sessionIds 按深度优先叶子顺序消费，
 * 第一个固定为根会话。数量不足时回退到单窗格。
 */
export function buildPaneLayout(
    shape: PaneShapeSnapshot | null,
    sessionIds: string[],
): PaneLayoutNode | null {
    if (!shape) return sessionIds[0] ? makePaneLeaf(sessionIds[0]) : null;
    if (countPaneShape(shape) !== sessionIds.length) {
        return sessionIds[0] ? makePaneLeaf(sessionIds[0]) : null;
    }
    let index = 0;
    const build = (current: PaneShapeSnapshot | null): PaneLayoutNode => {
        if (!current) {
            const sessionId = sessionIds[index] ?? "";
            index += 1;
            return makePaneLeaf(sessionId);
        }
        return makePaneSplit(
            current.orientation,
            build(current.first),
            build(current.second),
            current.ratio,
        );
    };
    return build(shape);
}
