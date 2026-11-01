export enum AppEvent {
    SyncStatus = "sync:status",
    SyncUpdatesAvailable = "sync:updates-available",
    SyncError = "sync:error",
    SshData = "ssh:data",
    SshClosed = "ssh:closed",
    /** 服务器发起的交互式认证问答（MFA/OTP） */
    SshAuthPrompt = "ssh:auth-prompt",
    UpdaterProgress = "updater:progress",
    FileDrop = "app:file-drop",
    /** 浮动窗口请求把会话挂回主窗口标签栏 */
    FloatingDock = "floating:dock-request",
    /** 外部编辑器保存后自动回传的结果 */
    EditorSaved = "editor:saved",
}