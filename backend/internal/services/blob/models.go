package blob

type ItemType string

const (
	TypeHost   ItemType = "host"
	TypeKey    ItemType = "key"
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
