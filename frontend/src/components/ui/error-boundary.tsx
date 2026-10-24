// 错误边界：捕获子组件渲染异常，防止整个应用崩溃黑屏
// 显示完整错误信息和堆栈，方便排查问题

import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "@/i18n";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error?: Error;
    info?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("ErrorBoundary caught:", error, info);
        this.setState({ info });
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: undefined, info: undefined });
    };

    render() {
        if (this.state.hasError) {
            return this.props.fallback ?? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6">
                    <p className="text-sm font-medium text-destructive">
                        {i18n.t("common:render_error")}
                    </p>
                    <div className="max-w-lg w-full rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3">
                        <p className="text-xs font-mono break-all text-[var(--fg-strong)]">
                            {this.state.error?.message ?? i18n.t("common:unknown_error")}
                        </p>
                        {this.state.error?.stack && (
                            <pre className="mt-2 max-h-48 overflow-auto text-[0.6875rem] font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-all">
                                {this.state.error.stack}
                            </pre>
                        )}
                        {this.state.info?.componentStack && (
                            <pre className="mt-2 max-h-32 overflow-auto text-[0.6875rem] font-mono text-[var(--fg-subtle)] whitespace-pre-wrap break-all">
                                {this.state.info.componentStack}
                            </pre>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={this.handleRetry}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        {i18n.t("common:retry")}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
