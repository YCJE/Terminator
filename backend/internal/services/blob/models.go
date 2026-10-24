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

	// 连接成功后自动执行的命令（可选，明文存于加密 blob 内）
	OnConnect string `json:"onConnect,omitempty"`
}

type SavedKey struct {
	ID         string   `json:"id"`
	Type       ItemType `json:"type"`
	Name       string   `json:"name"`
	PrivateKey string   `json:"privateKey"`
}

// Snippet 表示一条可复用的代码片段/快捷命令
type Snippet struct {
	ID      string   `json:"id"`
	Type    ItemType `json:"type"`
	Name    string   `json:"name"`
	Group   string   `json:"group,omitempty"`
	Command string   `json:"command"`
}
