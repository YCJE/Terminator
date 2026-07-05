// 错误边界：捕获子组件渲染异常，防止整个应用崩溃黑屏

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("ErrorBoundary caught:", error, info);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback ?? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
                    <p className="text-sm font-medium text-destructive">组件渲染出错</p>
                    <p className="max-w-md text-xs text-muted-foreground">{this.state.error?.message}</p>
                </div>
            );
        }
        return this.props.children;
    }
}
