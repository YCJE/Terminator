package emitters

// FileDropPayload 描述一次来自系统的外部文件拖放。
// Wails 在 Windows 上通过 chrome.webview 传递文件路径，
// 前端无法从 HTML5 DataTransfer 中拿到本地绝对路径，因此统一由后端转发。
type FileDropPayload struct {
	// Files 为拖入的本地文件绝对路径
	Files []string `json:"files"`
	// SessionID 取自拖放目标元素上的 data-session-id
	SessionID string `json:"sessionId"`
	// Kind 取自拖放目标元素上的 data-drop-kind（terminal / sftp）
	Kind string `json:"kind"`
}

const FileDropEvent = "app:file-drop"
