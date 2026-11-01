import './assets/main.css'
import "./i18n.ts"
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { FloatingTerminalApp } from './components/terminal/FloatingTerminalApp.tsx'
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
            retry: false,
        }
    }
})

// 多窗口：浮动终端窗口以 #/floating 打开，只渲染单个终端视图，
// 不加载主窗口的侧栏/标签栏/工作区恢复等逻辑。
const isFloatingWindow = window.location.hash.startsWith("#/floating");

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        {isFloatingWindow ? (
            <FloatingTerminalApp/>
        ) : (
            <QueryClientProvider client={queryClient}>
                <App/>
            </QueryClientProvider>
        )}
    </React.StrictMode>,
)
