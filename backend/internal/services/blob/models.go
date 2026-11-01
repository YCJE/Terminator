package blob

type ItemType string

const (
	TypeHost    ItemType = "host"
	TypeKey     ItemType = "key"
	TypeSnippet ItemType = "snippet" // 代码片段类型
)

type VaultItemHeader struct {
	Type ItemType `json:"type"`
}

type Host struct {
	ID         string   `json:"id"`
	Type       ItemType `json:"type"`
	Name       string   `json:"name"`
	Group      string   `json:"group,omitempty"`
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	Username   string   `json:"username"`
	Password   string   `json:"password,omitempty"`
	KeyID      string   `json:"keyId,omitempty"`
	JumpHostID string   `json:"jumpHostId,omitempty"` // 跳板机 Host ID，支持 SSH 多跳

	// 代理配置（可选）
	ProxyType     string `json:"proxyType,omitempty"` // "http" | "socks5" | "" (无代理)
	ProxyHost     string `json:"proxyHost,omitempty"`
	ProxyPort     int    `json:"proxyPort,omitempty"`
	ProxyUsername string `json:"proxyUsername,omitempty"`
	ProxyPassword string `json:"proxyPassword,omitempty"`

	// SSH Agent 转发（可选）
	AgentForwarding bool `json:"agentForwarding,omitempty"`

	// KeyboardInteractive 启用交互式认证（MFA/OTP），服务器发起问答时前端弹窗填写
	KeyboardInteractive bool `json:"keyboardInteractive,omitempty"`
	// Certificate 是 OpenSSH 用户证书内容（*-cert.pub），与 KeyID 对应的私钥配对使用
	Certificate string `json:"certificate,omitempty"`

	// 连接成功后自动执行的命令（可选，明文存于加密 blob 内）
	OnConnect string `json:"onConnect,omitempty"`

	// ── 会话高级参数（随主机保存） ──────────────────────────────
	// TermType 是请求 PTY 时上报的终端类型；空值为 xterm-256color。
	TermType string `json:"termType,omitempty"`
	// ConnectTimeout 是建立连接的总超时秒数；0 使用默认 15 秒。
	ConnectTimeout int `json:"connectTimeout,omitempty"`
	// KeepAlive 是保活间隔秒数：0 默认 30 秒，负数关闭保活。
	KeepAlive int `json:"keepAlive,omitempty"`
	// Encoding 是远端字符编码；空值/utf-8 表示 UTF-8。
	Encoding string `json:"encoding,omitempty"`
}

type SavedKey struct {
	ID         string   `json:"id"`
	Type       ItemType `json:"type"`
	Name       string   `json:"name"`
	PrivateKey string   `json:"privateKey"`
	// Passphrase 是加密私钥的解密口令，随密钥一起存入加密 blob。
	// 仅对带口令的私钥有意义；无口令私钥保持为空。
	Passphrase string `json:"passphrase,omitempty"`
}

// Snippet 表示一条可复用的代码片段/快捷命令
type Snippet struct {
	ID          string   `json:"id"`
	Type        ItemType `json:"type"`
	Name        string   `json:"name"`
	Group       string   `json:"group,omitempty"`
	Description string   `json:"description,omitempty"`
	Command     string   `json:"command"`
	// Pinned 置顶显示在片段面板顶部；旧数据无该字段时按 false 处理
	Pinned bool `json:"pinned,omitempty"`
}
