package ssh

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/services/charset"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
	sshagent "github.com/xanzy/ssh-agent"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/net/proxy"
)

type SSHEmitter interface {
	EmitData(sessionID string, data []byte)
	EmitClosed(sessionID string)
}

// SessionLogConfig 提供会话日志的运行时开关。
// 用接口而非固定布尔值，使设置变更无需重启应用即可生效。
type SessionLogConfig interface {
	SessionLogEnabled() bool
}

type SSHConnectionConfig struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
	// PrivateKeyPassphrase 是加密私钥的解密口令（可选）。
	// 只在私钥带口令时需要，随会话参数由前端从保险库中解密后传入。
	PrivateKeyPassphrase string `json:"privateKeyPassphrase,omitempty"`
	// JumpHost 跳板机配置（可选），通过跳板机建立到目标的 SSH 隧道
	JumpHost *JumpHostConfig `json:"jumpHost,omitempty"`

	// Proxy 代理配置（可选）
	ProxyType     string `json:"proxyType,omitempty"` // "http" | "socks5" | "" (无代理)
	ProxyHost     string `json:"proxyHost,omitempty"`
	ProxyPort     int    `json:"proxyPort,omitempty"`
	ProxyUsername string `json:"proxyUsername,omitempty"`
	ProxyPassword string `json:"proxyPassword,omitempty"`

	// AgentForwarding 启用 SSH Agent 认证与转发（可选）
	AgentForwarding bool `json:"agentForwarding,omitempty"`

	// KeyboardInteractive 启用 keyboard-interactive 认证（MFA/OTP）。
	// 服务器发起的任意问答都会推送到前端弹窗填写；未开启时，
	// 只有纯密码问题会静默使用已保存的密码回答。
	KeyboardInteractive bool `json:"keyboardInteractive,omitempty"`
	// Certificate 是 OpenSSH 用户证书内容（*-cert.pub 文件），
	// 必须与 PrivateKey 配对使用，由 CA 签发后服务器才接受该私钥。
	Certificate string `json:"certificate,omitempty"`

	// ── 会话高级参数 ──────────────────────────────────────────
	// TermType 是请求 PTY 时上报的终端类型；空值使用 xterm-256color。
	// 少数老旧设备只识别 vt100/ansi 等传统类型。
	TermType string `json:"termType,omitempty"`
	// ConnectTimeout 是建立连接的总超时秒数（含跳板与代理握手）。
	// 0 使用默认值 15 秒，上限 120 秒。
	ConnectTimeout int `json:"connectTimeout,omitempty"`
	// KeepAlive 是连接保活间隔秒数：0 使用默认 30 秒，负数关闭保活。
	KeepAlive int `json:"keepAlive,omitempty"`
	// Encoding 是远端字符编码（如 gbk、big5）；空值/utf-8 表示 UTF-8。
	// 仅影响键盘输入转码与前端输出解码，不改变 SSH 协议本身。
	Encoding string `json:"encoding,omitempty"`
}

// JumpHostConfig 跳板机配置。
// JumpHost 支持嵌套，用于多级链式跳转：config.JumpHost 为最外层跳板
// （由本机直接连接），其 JumpHost 字段指向再往内一层的跳板，依此类推。
// 跳板机的 keyboard-interactive 暂不支持：跳板阶段没有可交互的会话上下文。
type JumpHostConfig struct {
	Host                 string          `json:"host"`
	Port                 int             `json:"port"`
	Username             string          `json:"username"`
	Password             string          `json:"password,omitempty"`
	PrivateKey           string          `json:"privateKey,omitempty"`
	PrivateKeyPassphrase string          `json:"privateKeyPassphrase,omitempty"`
	Certificate          string          `json:"certificate,omitempty"`
	JumpHost             *JumpHostConfig `json:"jumpHost,omitempty"`
}

// AuthPrompt 交互式认证中的一条问答。
type AuthPrompt struct {
	Prompt string `json:"prompt"`
	// Echo 为 true 表示服务器允许明文回显（如用户名），前端用普通输入框。
	Echo bool `json:"echo"`
}

// AuthPromptRequest 是等待用户填写的交互式认证请求。
// RequestID 在每次问答时唯一，SubmitAuthResponses/CancelAuthPrompt 按它定位。
type AuthPromptRequest struct {
	RequestID   string       `json:"requestId"`
	SessionID   string       `json:"sessionId"`
	Host        string       `json:"host"`
	Username    string       `json:"username"`
	Instruction string       `json:"instruction"`
	Prompts     []AuthPrompt `json:"prompts"`
}

// AuthPrompter 由桌面层实现：把交互式认证问答推送到前端。
// 收到 EmitAuthPrompt 后，前端调用 SubmitAuthResponses 或 CancelAuthPrompt。
type AuthPrompter interface {
	EmitAuthPrompt(request AuthPromptRequest)
}

// authAnswer 是交互式认证等待结果：responses 为各问题的回答，canceled 表示用户取消。
type authAnswer struct {
	responses []string
	canceled  bool
}

// 交互式认证问答的限制：提示语数量与长度都来自服务器，
// 截断可避免异常服务端用超长内容撑爆 IPC 与弹窗渲染。
const (
	maxAuthQuestions    = 10
	maxAuthPromptLen    = 256
	maxAuthResponseLen  = 4096
	maxAuthInstruction  = 512
	defaultAuthPromptTO = 120 * time.Second
)

// authPromptTimeout 是等待用户回答的总时长。作为变量保留，便于测试缩短。
var authPromptTimeout = defaultAuthPromptTO

// maxJumpHops 跳板机链的最大层级，防止异常配置导致建链过程长时间挂起。
const maxJumpHops = 8

// PortForwardSpec 端口转发规格
type PortForwardSpec struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionId"`
	Type       string `json:"type"` // "local" 或 "remote"
	LocalHost  string `json:"localHost"`
	LocalPort  int    `json:"localPort"`
	RemoteHost string `json:"remoteHost"`
	RemotePort int    `json:"remotePort"`
}

type activeSession struct {
	client      *ssh.Client
	session     *ssh.Session
	stdin       io.WriteCloser
	stdout      io.Reader
	pipeCloser  io.Closer
	sftpClient  *sftp.Client         // 懒加载，首次使用时创建
	connConfig  *SSHConnectionConfig // 保存配置用于连接池释放
	logFile     *os.File             // 会话日志文件（可选）
	logMu       sync.Mutex           // 保护 logFile 的并发写入
	agentCloser io.Closer            // SSH Agent 转发连接（可选，清理时关闭）
	encoding    charset.Spec         // 键盘输入的目标编码（零值 = UTF-8）
	// retiredSFTP 记录被 AdoptSFTPClient 替换下来的旧 SFTP 客户端。
	// 替换时不能立即关闭（上面可能仍有并发传输），但也不能永远不关：
	// 每个客户端都占着一条 SSH 通道，列表重试反复失效时会持续累积。
	// 会话结束时统一关闭。
	retiredSFTP []*sftp.Client
}

// closeLogFile 关闭会话日志文件（幂等）。
// 与 writeLog 共用 logMu：Close 若与在途 Write 交叉，会静默丢掉最后一段日志。
// 关闭后把句柄置空，后续到达的输出按"未开启日志"直接忽略，
// 避免向已关闭的文件写入而产生无意义的错误日志。
func (a *activeSession) closeLogFile() {
	if a == nil {
		return
	}
	a.logMu.Lock()
	defer a.logMu.Unlock()
	if a.logFile == nil {
		return
	}
	_ = a.logFile.Close()
	a.logFile = nil
}

type SshService struct {
	emitter  SSHEmitter
	mu       sync.RWMutex
	sessions map[string]*activeSession

	// connecting 记录正在建立连接的会话 ID。Disconnect 只能在会话已注册时
	// 找到清理目标，而连接建立（TCP + 握手 + 认证）可能持续数十秒；用户在
	// "连接中"关闭标签时若不留下标记，Connect 成功后会话会永久遗留在
	// sessions 里，既不断开也不再有任何视图引用。
	connecting map[string]struct{}
	// cancelled 记录在连接建立期间被取消的会话 ID：Connect 注册会话时
	// 发现该标记会立即自行清理并返回失败，而不是留下一个"幽灵会话"。
	cancelled map[string]struct{}

	// knownHostsPath is the location of the known_hosts file used for
	// Trust-On-First-use host key verification. Storing pinned host keys
	// prevents man-in-the-middle attacks on subsequent connections.
	knownHostsPath string
	hostsMu        sync.Mutex

	// 连接池：按 connKey 复用 *ssh.Client，多个 session 共享同一 SSH 连接
	connPool   map[string]*pooledConn
	connPoolMu sync.Mutex

	// retired 记录已被移出连接池、但仍有会话持有的旧连接及其剩余引用计数。
	// 池中条目被剔除/替换时，若该连接仍有持有者，不能立即关闭（否则会打断
	// 其它会话），必须把剩余计数转移到这里，由各持有者各自递减、归零才关闭。
	retired map[*ssh.Client]int

	// probes 记录每个 client 是否有 keepalive 探测正在进行中（key = *ssh.Client）。
	// 探测在连接黑洞时会一直阻塞在 ssh 库的 readPacket 上，无法在超时后回收其
	// goroutine；若每次都新建探测（keepalive 每 30s 一次），goroutine 会无界增长。
	// 因此同一 client 只保留一个在途探测，其余调用复用其结果。
	probes   map[*ssh.Client]*connProbe
	probesMu sync.Mutex

	// latencyProbes 记录每个 client 正在进行的延迟探测。
	// 与 probes 同理：连接黑洞时 SendRequest 会永久阻塞，前端每 10 秒轮询一次，
	// 若每次都新建 goroutine，关闭 keepalive 时会无界累积。同一 client 共享结果。
	latencyProbes map[*ssh.Client]*latencyProbe
	latencyMu     sync.Mutex

	// 端口转发管理
	forwards   map[string]net.Listener // key = forward ID
	forwardsMu sync.Mutex

	// sessionID → forwardID[] 反向索引，用于会话断开时批量清理端口转发
	sessionForwards map[string][]string

	// forwardConns 记录每个转发当前活跃的隧道连接（key = forward ID）。
	// 仅关闭 listener 不会关闭已 Accept 的连接，其 io.Copy goroutine 会一直存活
	// 到对端断开，造成 fd/goroutine 泄漏，且"已删除"的转发仍在传输数据；
	// 因此移除/清理转发时须显式关闭这些连接。与 forwards 共用 forwardsMu 保护。
	forwardConns map[string]map[net.Conn]struct{}

	// logDir 会话日志输出目录（空则不记录日志）
	logDir string
	// logConfig 会话日志开关，为 nil 时视为关闭
	logConfig SessionLogConfig

	// authPrompter 交互式认证问答的前端通道；为 nil 时只能自动回答密码类问题
	authPrompter AuthPrompter
	// authMu 保护 authWaiters（key = request ID）
	authMu      sync.Mutex
	authWaiters map[string]chan authAnswer

	// agentForwards 记录每个池化 client 上已注册的 agent 转发处理器及引用它的会话数。
	// ForwardToAgent 只能对同一个 *ssh.Client 注册一次，第二个会话再注册会失败；
	// 而处理器按 client 生效、不属于某个会话，若各会话结束时各自关闭，先结束的会话
	// 会把仍在运行的其它会话的 agent 转发一并断掉。因此按 client 共享并在
	// 引用归零时关闭。
	agentForwards   map[*ssh.Client]*agentForwardState
	agentForwardsMu sync.Mutex
}

// agentForwardState 是一个 client 上共享的 agent 转发注册。
type agentForwardState struct {
	closer io.Closer
	refs   int
}

// agentForwardLease 是单个会话对共享 agent 转发的引用，Close 时递减引用计数。
type agentForwardLease struct {
	svc    *SshService
	client *ssh.Client
	state  *agentForwardState
	once   sync.Once
}

func (l *agentForwardLease) Close() error {
	l.once.Do(func() {
		l.svc.agentForwardsMu.Lock()
		st, ok := l.svc.agentForwards[l.client]
		var toClose io.Closer
		if ok && st == l.state {
			st.refs--
			if st.refs <= 0 {
				delete(l.svc.agentForwards, l.client)
				toClose = st.closer
			}
		}
		l.svc.agentForwardsMu.Unlock()
		if toClose != nil {
			_ = toClose.Close()
		}
	})
	return nil
}

// acquireAgentForward 获取（必要时注册）client 上共享的 agent 转发。
// 返回的 Closer 由会话持有，会话结束时调用一次即可。
func (s *SshService) acquireAgentForward(client *ssh.Client) (io.Closer, error) {
	s.agentForwardsMu.Lock()
	defer s.agentForwardsMu.Unlock()

	if st, ok := s.agentForwards[client]; ok {
		st.refs++
		return &agentForwardLease{svc: s, client: client, state: st}, nil
	}

	ag, ac, err := sshagent.New()
	if err != nil {
		return nil, err
	}
	if err := agent.ForwardToAgent(client, ag); err != nil {
		_ = ac.Close()
		return nil, err
	}
	st := &agentForwardState{closer: ac, refs: 1}
	s.agentForwards[client] = st
	return &agentForwardLease{svc: s, client: client, state: st}, nil
}

// pooledConn 池化 SSH 连接，引用计数管理生命周期
type pooledConn struct {
	client   *ssh.Client
	refCount int
	poisoned bool // 标记为死连接，新 acquire 跳过，refCount 归零时删除
}

const timeout = 15 * time.Second

const (
	// defaultTermType 是请求 PTY 时的默认终端类型。
	defaultTermType = "xterm-256color"
	// maxTermTypeLen 限制 TERM 长度：该值会进入 SSH 协议报文。
	maxTermTypeLen = 40
	// maxConnectTimeout 限制连接超时上限，避免误填超大值使断开操作长时间无响应。
	maxConnectTimeout = 120
	// defaultKeepAlive 是未指定保活间隔时使用的默认值。
	defaultKeepAlive = 30 * time.Second
	// maxKeepAlive 限制保活间隔上限。
	maxKeepAlive = 300 * time.Second
	// maxPortForwards 限制单个应用内端口转发总数，防止资源耗尽。
	maxPortForwards = 100
)

// terminalType 返回请求 PTY 时使用的终端类型。
// 允许字母、数字与常见分隔符；非法值回退默认，避免把控制字符带进协议。
func terminalType(config *SSHConnectionConfig) string {
	term := strings.TrimSpace(config.TermType)
	if term == "" || len(term) > maxTermTypeLen {
		return defaultTermType
	}
	for _, r := range term {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '/'
		if !ok {
			return defaultTermType
		}
	}
	return term
}

// joinHostPort 拼接 host:port，兼容 IPv6 字面量与 "[::1]" 写法。
// 直接用 "%s:%d" 会让 "::1:22" 因冒号过多而拨号/监听失败。
func joinHostPort(host string, port int) string {
	host = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(host), "["), "]")
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// connectionTimeout 返回建立连接（含跳板/代理握手）的超时。
func connectionTimeout(config *SSHConnectionConfig) time.Duration {
	secs := config.ConnectTimeout
	if secs <= 0 {
		return timeout
	}
	if secs > maxConnectTimeout {
		secs = maxConnectTimeout
	}
	return time.Duration(secs) * time.Second
}

// keepAliveInterval 返回保活间隔：0 表示关闭。
// 负值显式关闭；0 使用默认 30 秒，避免旧配置丢失保活能力。
func keepAliveInterval(config *SSHConnectionConfig) time.Duration {
	if config.KeepAlive < 0 {
		return 0
	}
	if config.KeepAlive == 0 {
		return defaultKeepAlive
	}
	interval := time.Duration(config.KeepAlive) * time.Second
	if interval > maxKeepAlive {
		return maxKeepAlive
	}
	return interval
}

const batchRatePerSecond = 60

func NewSshService(emitter SSHEmitter, logDir string) *SshService {
	return &SshService{
		emitter:         emitter,
		sessions:        make(map[string]*activeSession),
		connecting:      make(map[string]struct{}),
		cancelled:       make(map[string]struct{}),
		knownHostsPath:  defaultKnownHostsPath(),
		connPool:        make(map[string]*pooledConn),
		retired:         make(map[*ssh.Client]int),
		probes:          make(map[*ssh.Client]*connProbe),
		latencyProbes:   make(map[*ssh.Client]*latencyProbe),
		forwards:        make(map[string]net.Listener),
		sessionForwards: make(map[string][]string),
		forwardConns:    make(map[string]map[net.Conn]struct{}),
		agentForwards:   make(map[*ssh.Client]*agentForwardState),
		logDir:          logDir,
		authWaiters:     make(map[string]chan authAnswer),
	}
}

func defaultKnownHostsPath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "Terminator", "known_hosts")
	}
	return "known_hosts"
}

// SetSessionLogConfig 注入会话日志开关。未注入时视为关闭：
// 会话日志会把完整终端输出明文落盘，不应在未明确开启的情况下记录。
//
//wails:ignore 仅由后端装配（main.go）调用，参数是接口类型无法 JSON 序列化，不暴露给前端
func (s *SshService) SetSessionLogConfig(cfg SessionLogConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logConfig = cfg
}

// sessionLogEnabled 判断当前是否应记录会话日志。
func (s *SshService) sessionLogEnabled() bool {
	s.mu.RLock()
	cfg := s.logConfig
	s.mu.RUnlock()
	return cfg != nil && cfg.SessionLogEnabled()
}

// CleanupSessionLogs 删除会话日志目录中超过保留期的日志文件，返回删除数量。
// 目录不存在或为空视为无需清理，不报错。
func CleanupSessionLogs(dir string, retentionDays int) (int, error) {
	return cleanupSessionLogsBefore(dir, retentionDays, time.Now())
}

// cleanupSessionLogsBefore 是 CleanupSessionLogs 的可测实现，基准时间由调用方给出。
//
// 会话日志记录完整终端输出（可能含口令、令牌、连接串），必须按保留期回收，
// 否则敏感内容会无限期留在磁盘上。清理失败不视为致命错误：
// 单个文件删除失败只跳过该文件，避免一个异常文件阻塞整轮回收。
func cleanupSessionLogsBefore(dir string, retentionDays int, now time.Time) (int, error) {
	if dir == "" {
		return 0, nil
	}
	if retentionDays < 1 {
		retentionDays = 1
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	cutoff := now.AddDate(0, 0, -retentionDays)
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".log") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			slog.Debug("failed to remove expired session log", "name", entry.Name(), "error", err)
			continue
		}
		removed++
	}
	return removed, nil
}

// sessionLogFilename 把会话 ID 规整为安全的日志文件名。
//
// 会话 ID 由前端传入，若直接拼进 filepath.Join，Windows 上带 `\` 或 `..` 的 ID
// 会使日志写入逃出 logDir、覆盖任意可写文件。这里只保留 [A-Za-z0-9._-]，
// 其余字符替换为下划线；规整后为空、"." 或 ".." 时返回空串，调用方跳过记录。
// 正常的 UUID 会话 ID 会原样通过，行为与之前一致。
func sessionLogFilename(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	name := b.String()
	if name == "" || name == "." || name == ".." {
		return ""
	}
	return name + ".log"
}

// Connect establishes an SSH session with connection pooling and optional Jump Host support.
//
// 连接复用：同一 host:port:user 的多个 session 共享 *ssh.Client（引用计数）
// Jump Host：通过跳板机建立 TCP 隧道，再在隧道上建立到目标的 SSH 连接
func (s *SshService) Connect(config *SSHConnectionConfig) error {
	// 绑定层允许前端直接传 null：若不校验，下方 config.Host 会触发空指针 panic。
	if config == nil {
		return apperror.Validation("connection config is required")
	}
	// 会话 ID 是前端生成并用于后续 Input/Resize/Disconnect 的唯一索引：
	// 空 ID 会让多个会话落到同一个 map key，输入被写到错误的会话上。
	if strings.TrimSpace(config.ID) == "" {
		return apperror.Validation("session id is required")
	}
	// 配置校验与 TestConnection 保持一致：空 Host 会被拼成 ":22"，net.Dial
	// 会直接连到本机；端口越界/空用户名也应在进入网络层前拒绝。
	if strings.TrimSpace(config.Host) == "" {
		return apperror.Validation("host is required")
	}
	if config.Port <= 0 || config.Port > 65535 {
		return apperror.Validation("port must be between 1 and 65535")
	}
	if strings.TrimSpace(config.Username) == "" {
		return apperror.Validation("username is required")
	}
	// 编码在连接阶段校验：非法值不应等到用户敲键盘时才报错。
	encodingSpec, err := charset.Parse(config.Encoding)
	if err != nil {
		return apperror.Validation(err.Error())
	}

	// 标记"连接建立中"：此期间 Disconnect 找不到 sessions 条目，只能依靠
	// 该标记与 cancelled 集合把取消意图传递到下面的注册点。
	s.mu.Lock()
	s.connecting[config.ID] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.connecting, config.ID)
		delete(s.cancelled, config.ID)
		s.mu.Unlock()
	}()

	client, err := s.acquireClient(config)
	if err != nil {
		return err
	}

	session, err := client.NewSession()
	if err != nil {
		s.releaseClient(config, client)
		return apperror.SSHConnectionFailed("failed to create session", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		s.releaseClient(config, client)
		return err
	}

	pr, pw := io.Pipe()
	session.Stdout = pw
	session.Stderr = pw

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200,
		ssh.TTY_OP_OSPEED: 115200,
	}

	if err = session.RequestPty(terminalType(config), 24, 80, modes); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		_ = session.Close()
		s.releaseClient(config, client)
		return apperror.SSHConnectionFailed("failed to request PTY", err)
	}

	// Agent 转发：必须在 Shell() 之前调用 RequestAgentForwarding()，
	// 因为 SSH 库在 session 启动后会拒绝该请求。
	// ForwardToAgent 将本地 agent 注册到 SSH client，处理服务器发起的 agent 通道。
	var agentCloser io.Closer
	if config.AgentForwarding {
		// 处理器按 client 共享：同一池化连接上的第二个会话不能再注册，
		// 关闭也不能由任一会话单独触发（见 acquireAgentForward）。
		if lease, agentErr := s.acquireAgentForward(client); agentErr == nil {
			agentCloser = lease // 保存引用，会话结束时释放
		} else {
			slog.Debug("failed to set up agent forwarding on client", "session", config.ID, "error", agentErr)
		}
		// best-effort：忽略错误，不影响正常连接
		if ferr := agent.RequestAgentForwarding(session); ferr != nil {
			slog.Debug("agent forwarding request failed", "session", config.ID, "error", ferr)
		}
	}

	if err = session.Shell(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		_ = session.Close()
		// agentCloser 已在 Shell() 之前建立：忽略此分支会让 agent 转发连接
		// （Windows 上为命名管道句柄）随每次失败连接累积泄漏。
		if agentCloser != nil {
			_ = agentCloser.Close()
		}
		s.releaseClient(config, client)
		return apperror.SSHConnectionFailed("failed to start shell", err)
	}

	// 会话日志：仅在用户明确开启且配置了 logDir 时记录。
	// 日志内容为完整终端输出，可能含口令与令牌，默认不落盘。
	var logFile *os.File
	if s.logDir != "" && s.sessionLogEnabled() {
		// 会话 ID 来自前端，不能直接拼进路径：含分隔符的 ID 会逃出日志目录。
		if name := sessionLogFilename(config.ID); name != "" {
			logPath := filepath.Join(s.logDir, name)
			logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
			if err != nil {
				slog.Warn("failed to create session log file, continuing without logging", "path", logPath, "error", err)
				logFile = nil
			}
		}
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("session.Wait goroutine panic", "panic", r, "stack", string(debug.Stack()))
			}
		}()

		// Keepalive 监测：每 30 秒检测连接是否存活
		// 防止半开连接导致 session.Wait() 无限阻塞
		// 注意：keepalive 失败时只关闭 session/pw，不关闭共享 client
		// client 的生命周期由连接池 refCount 管理
		keepaliveDone := make(chan struct{})
		// 保活间隔来自会话高级参数：负值关闭，0 使用默认 30 秒
		if interval := keepAliveInterval(config); interval > 0 {
			go func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("keepalive goroutine panic", "panic", r, "stack", string(debug.Stack()))
					}
				}()
				ticker := time.NewTicker(interval)
				defer ticker.Stop()
				for {
					select {
					case <-keepaliveDone:
						return
					case <-ticker.C:
						if !s.isConnectionAlive(client) {
							slog.Warn("SSH keepalive failed, closing session", "session", config.ID)
							_ = session.Close()
							_ = pw.Close()
							return
						}
					}
				}
			}()
		}

		// 使用 defer 确保 panic 时 keepaliveDone 和 pw 也被正确清理
		defer close(keepaliveDone)
		defer pw.Close()
		_ = session.Wait()
	}()

	s.mu.Lock()
	old := s.sessions[config.ID]
	currentSession := &activeSession{
		client:      client,
		session:     session,
		stdin:       stdin,
		stdout:      pr,
		pipeCloser:  pw,
		connConfig:  config,
		encoding:    encodingSpec,
		logFile:     logFile,
		agentCloser: agentCloser,
	}
	_, cancelled := s.cancelled[config.ID]
	if !cancelled {
		s.sessions[config.ID] = currentSession
	}
	// 替换旧会话时必须与安装新会话在同一临界区摘除旧转发：若先安装再清理，
	// 期间刚为新会话登记的转发会被 cleanupForwards 按 sessionID 一并误删，
	// 而调用方已收到"创建成功"。
	forwardIDs, forwardListeners := s.detachForwardsLocked(config.ID)
	s.mu.Unlock()

	if cancelled {
		// 用户已在"连接中"关闭该标签：不注册会话，立即回收刚建立的连接，
		// 否则它会一直挂在 sessions 里直到应用退出。
		_ = pw.Close()
		_ = pr.Close()
		_ = session.Close()
		s.releaseClient(config, client)
		if agentCloser != nil {
			_ = agentCloser.Close()
		}
		if logFile != nil {
			_ = logFile.Close()
		}
		s.closeForwardListeners("", forwardIDs, forwardListeners)
		s.emitter.EmitClosed(config.ID)
		return apperror.SSHSessionNotFound()
	}

	s.closeForwardListeners(config.ID, forwardIDs, forwardListeners)

	if old != nil {
		// 旧会话的日志不在这里关闭：其 streamOutput 可能还有一批输出待落盘，
		// 提前关闭会丢掉会话结束前的最后一段内容。日志由 streamOutput 在
		// 管道 EOF 后自行关闭，两个句柄短暂并发追加同名文件是安全的。
		if old.pipeCloser != nil {
			_ = old.pipeCloser.Close()
		}
		if old.session != nil {
			_ = old.session.Close()
		}
		if old.connConfig != nil {
			s.releaseClient(old.connConfig, old.client)
		} else if old.client != nil {
			_ = old.client.Close()
		}
		closeResourceWithTimeout("sftp client", old.sftpClient)
		closeRetiredSFTP(old.retiredSFTP)
		closeResourceWithTimeout("ssh agent", old.agentCloser)
	}

	go s.streamOutput(config.ID, pr, currentSession)

	return nil
}

// connKey 生成连接池的键
func connKey(config *SSHConnectionConfig) string {
	base := fmt.Sprintf("%s:%d:%s", config.Host, config.Port, config.Username)
	// 跳板机链的每一级都要参与键的构成，否则不同链路会错误复用同一连接
	for jh := config.JumpHost; jh != nil; jh = jh.JumpHost {
		base += fmt.Sprintf("->%s:%d:%s", jh.Host, jh.Port, jh.Username)
	}
	if config.ProxyType != "" {
		base += fmt.Sprintf("@proxy:%s:%s:%d", config.ProxyType, config.ProxyHost, config.ProxyPort)
	}
	// 复用的是「已完成认证」的 *ssh.Client：若只按路由组键，使用不同密码/私钥/
	// 代理凭据的连接会直接复用第一条连接的认证结果——第二条凭据即使错误也会
	// "连接成功"，代理账号也可能越权。把凭据与 Agent 转发配置折叠进键，
	// 保证不同认证信息各自独立建连。无任何凭据时保持原有键格式。
	if fp := credentialFingerprint(config); fp != "" {
		base += "#cred:" + fp
	}
	return base
}

// credentialFingerprint 生成认证相关字段的短指纹（仅用于内存中的连接池键）。
//
// 字段按长度前缀拼接，避免 "ab"+"c" 与 "a"+"bc" 产生相同输入。
// 无任何认证信息时返回空串，使仅按路由区分的旧键格式保持不变。
func credentialFingerprint(config *SSHConnectionConfig) string {
	var b strings.Builder
	hasCredential := false
	write := func(value string) {
		if value != "" {
			hasCredential = true
		}
		b.WriteString(strconv.Itoa(len(value)))
		b.WriteByte(':')
		b.WriteString(value)
		b.WriteByte('|')
	}

	write(config.Password)
	write(config.PrivateKey)
	write(config.PrivateKeyPassphrase)
	// 证书决定服务器看到的身份：配置了不同证书的连接不能复用同一认证结果
	write(config.Certificate)
	write(config.ProxyUsername)
	write(config.ProxyPassword)
	for jh := config.JumpHost; jh != nil; jh = jh.JumpHost {
		write(jh.Password)
		write(jh.PrivateKey)
		write(jh.PrivateKeyPassphrase)
		write(jh.Certificate)
	}
	if config.KeyboardInteractive {
		hasCredential = true
		b.WriteString("ki|")
	}
	if config.AgentForwarding {
		hasCredential = true
		b.WriteString("agent|")
	}

	if !hasCredential {
		return ""
	}
	sum := sha256.Sum256([]byte(b.String()))
	// 截取 12 字节：碰撞概率可忽略，同时避免键过长
	return fmt.Sprintf("%x", sum[:12])
}

// probeTimeout keepalive 探测超时时间。
const probeTimeout = 3 * time.Second

// probeJoinTimeout 复用他人探测结果时的等待上限。
//
// 必须显著大于 probeTimeout：探测发起方在高 RTT 链路上可能需要数秒才收到
// 应答，若复用以同样的 3 秒等待，就会出现"探测其实成功、等待方却判定连接
// 已死"的误杀——keepalive 会因此关闭健康会话，acquire 也会把可用连接标记
// poisoned 并重新拨号。
const probeJoinTimeout = 2 * probeTimeout

// connProbe 表示一次在途的连接存活探测，多个调用方共享其结果。
type connProbe struct {
	done  chan struct{}
	alive bool
}

// isConnectionAlive 发送 keepalive 请求检测连接是否存活。
//
// 探测依赖 ssh 库读取对端应答，连接为黑洞时会一直阻塞，超时后其 goroutine
// 也无法被回收。若每次调用都新建探测（keepalive 每 30s 一次、每次 acquire 一次），
// 这些 goroutine 会无界增长。因此对同一 client 只保留一个在途探测，其余调用
// 复用其结果；该探测 goroutine 会在连接最终被关闭（池中剔除/引用归零触发
// readPacket 返回错误）时退出，从而不再累积。
//
// 超时仅返回 false，不关闭 client：它可能是连接池中的共享连接，
// 由调用方决定如何处理（关闭 session，或把连接标记为 poisoned）。
func (s *SshService) isConnectionAlive(client *ssh.Client) bool {
	s.probesMu.Lock()
	if p, ok := s.probes[client]; ok {
		s.probesMu.Unlock()
		// 已有在途探测：复用其结果；超时仍视为不存活，与单次探测语义一致。
		select {
		case <-p.done:
			return p.alive
		case <-time.After(probeJoinTimeout):
			return false
		}
	}
	p := &connProbe{done: make(chan struct{})}
	s.probes[client] = p
	s.probesMu.Unlock()

	go func() {
		alive := false
		defer func() {
			if r := recover(); r != nil {
				alive = false
			}
			// 先写结果再 close(done)：等待方在收到 done 后读取 p.alive 是安全的
			p.alive = alive
			s.probesMu.Lock()
			// 仅当仍是当前探测时才移除，避免误删随后新建的探测
			if cur, ok := s.probes[client]; ok && cur == p {
				delete(s.probes, client)
			}
			s.probesMu.Unlock()
			close(p.done)
		}()
		_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
		alive = err == nil
	}()

	select {
	case <-p.done:
		return p.alive
	case <-time.After(probeTimeout):
		return false
	}
}

// acquireClient 从连接池获取或创建 SSH 客户端
// 复用前进行 keepalive 健康检查，剔除已断开的死连接
func (s *SshService) acquireClient(config *SSHConnectionConfig) (*ssh.Client, error) {
	key := connKey(config)

	s.connPoolMu.Lock()
	if pc, ok := s.connPool[key]; ok && pc.client != nil && !pc.poisoned {
		// 健康检查：发送 keepalive 验证连接是否存活
		client := pc.client
		s.connPoolMu.Unlock()

		if s.isConnectionAlive(client) {
			s.connPoolMu.Lock()
			// 二次确认池中条目未被其他 goroutine 移除，且期间没有被标记为
			// poisoned（并发 acquire 的探测可能已判定该连接失效）。若仍按
			// 成功复用，后续 NewSession 会在死连接上失败，用户侧表现为
			// 无缘无故连接失败。
			if pc2, ok := s.connPool[key]; ok && pc2.client == client && !pc2.poisoned {
				pc2.refCount++
				s.connPoolMu.Unlock()
				return client, nil
			}
			s.connPoolMu.Unlock()
		} else {
			// 连接已死。refCount>0 时不能立即关闭（仍有会话在用），仅标记
			// poisoned 让新 acquire 跳过；其剩余引用计数会在条目被替换时由
			// detachLocked 转入 retired，各持有者各自释放、归零时才关闭。
			var toClose *ssh.Client
			s.connPoolMu.Lock()
			if pc2, ok := s.connPool[key]; ok && pc2.client == client {
				if pc2.refCount <= 0 {
					toClose = s.detachLocked(key)
				} else {
					pc2.poisoned = true
				}
			}
			s.connPoolMu.Unlock()
			if toClose != nil {
				_ = toClose.Close()
			}
		}
	} else {
		s.connPoolMu.Unlock()
	}

	dialed, err := s.dialSSH(config)
	if err != nil {
		return nil, err
	}

	s.connPoolMu.Lock()
	if pc, ok := s.connPool[key]; ok && pc.client != nil && !pc.poisoned {
		// 竞态：期间其他 goroutine 已建立可复用连接，丢弃本次新拨的
		pc.refCount++
		existing := pc.client
		s.connPoolMu.Unlock()
		_ = dialed.Close()
		return existing, nil
	}
	// 安装新连接前先摘除池中残留的旧条目（poisoned，且可能仍有持有者）。
	// 若直接覆盖，旧连接的引用计数会丢失，任一持有者释放时都会立即关闭它，
	// 从而打断其余仍在使用该连接的会话。detachLocked 会把剩余计数转入 retired。
	stale := s.detachLocked(key)
	s.connPool[key] = &pooledConn{client: dialed, refCount: 1}
	s.connPoolMu.Unlock()

	if stale != nil {
		_ = stale.Close()
	}
	return dialed, nil
}

// detachLocked 从连接池摘除 key 的条目。若该连接仍有持有者（refCount>0），
// 把剩余引用计数转入 retired，使各持有者仍能安全释放、归零时才真正关闭；
// 否则返回该连接，由调用方在锁外关闭。调用方须持有 connPoolMu。
func (s *SshService) detachLocked(key string) (toClose *ssh.Client) {
	pc, ok := s.connPool[key]
	if !ok || pc.client == nil {
		return nil
	}
	delete(s.connPool, key)
	if pc.refCount > 0 {
		s.retired[pc.client] = pc.refCount
		return nil
	}
	return pc.client
}

// releaseClient 释放连接池引用。
// 传入 client 参数确保只递减/关闭该特定连接，避免按 key 操作时
// 误关池中已被替换的新连接。
func (s *SshService) releaseClient(config *SSHConnectionConfig, client *ssh.Client) {
	key := connKey(config)

	s.connPoolMu.Lock()
	pc, ok := s.connPool[key]
	if !ok || pc.client != client {
		// 该连接已不在池中（被健康检查剔除或已替换）：若它仍被其他会话持有
		// （retired 中留有计数），只递减，归零才关闭；否则直接关闭。
		if n, retired := s.retired[client]; retired {
			n--
			if n > 0 {
				s.retired[client] = n
				s.connPoolMu.Unlock()
				return
			}
			delete(s.retired, client)
			s.connPoolMu.Unlock()
			_ = client.Close()
			return
		}
		s.connPoolMu.Unlock()
		_ = client.Close()
		return
	}

	pc.refCount--
	shouldClose := pc.refCount <= 0
	if shouldClose {
		delete(s.connPool, key)
	}
	// Close 在锁外执行，避免网络 I/O 阻塞连接池
	s.connPoolMu.Unlock()
	if shouldClose {
		_ = client.Close()
	}
}

// dialSSH 建立 SSH 连接，支持直连、代理和 Jump Host
func (s *SshService) dialSSH(config *SSHConnectionConfig) (*ssh.Client, error) {
	authMethods, err := s.authMethods(config)
	if err != nil {
		return nil, apperror.SSHConnectionFailed("failed to prepare authentication", err)
	}

	// Agent 认证：如果启用 AgentForwarding，尝试从 SSH agent 获取密钥并作为首选认证方式
	if config.AgentForwarding {
		if agentAuth, agentCloser := buildAgentAuthMethod(); agentAuth != nil {
			authMethods = append([]ssh.AuthMethod{agentAuth}, authMethods...)
			// 认证在 dial 过程中完成，dial 返回后 agent 连接不再需要
			if agentCloser != nil {
				defer func() { _ = agentCloser.Close() }()
			}
		}
	}

	hostKeyCallback := s.makeHostKeyCallback(config.Host, config.Port)

	clientConfig := &ssh.ClientConfig{
		User:            config.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         connectionTimeout(config),
	}

	targetAddr := joinHostPort(config.Host, config.Port)

	if config.JumpHost != nil {
		return s.dialThroughJumpHost(config, clientConfig, targetAddr)
	}

	client, err := dialWithProxy("tcp", targetAddr, clientConfig, config)
	if err != nil {
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to %s", targetAddr), err)
	}
	return client, nil
}

// dialThroughJumpHost 依次穿透跳板机链建立到目标的 SSH 连接。
//
// config.JumpHost 为最外层跳板（由本机直接连接），其嵌套的 JumpHost 指向下一级，
// 依此类推，最后一段从最内层跳板机穿透到 targetAddr。单级跳板即为链长为 1 的特例。
//
// 任一步失败都会关闭已建立的各级连接；目标连接断开时同样清理整条链路，
// 避免中间连接泄漏。
func (s *SshService) dialThroughJumpHost(config *SSHConnectionConfig, targetConfig *ssh.ClientConfig, targetAddr string) (*ssh.Client, error) {
	// 展开跳板机链，最外层在前
	var chain []*JumpHostConfig
	for jh := config.JumpHost; jh != nil; jh = jh.JumpHost {
		if len(chain) >= maxJumpHops {
			return nil, apperror.SSHConnectionFailed(
				fmt.Sprintf("跳板机层级超过上限 %d", maxJumpHops), nil)
		}
		chain = append(chain, jh)
	}

	// 跳板机参数校验：空 Host 会被拼成 ":22" 从而连到本机控制台，
	// 端口越界/空用户名也只会在握手阶段报出难以理解的错误。
	for _, jh := range chain {
		if strings.TrimSpace(jh.Host) == "" {
			return nil, apperror.SSHConnectionFailed("跳板机地址不能为空", nil)
		}
		if jh.Port <= 0 || jh.Port > 65535 {
			return nil, apperror.SSHConnectionFailed(
				fmt.Sprintf("跳板机 %s 的端口必须是 1-65535", jh.Host), nil)
		}
		if strings.TrimSpace(jh.Username) == "" {
			return nil, apperror.SSHConnectionFailed(
				fmt.Sprintf("跳板机 %s 的用户名不能为空", jh.Host), nil)
		}
	}

	// established 保存已建立的各级连接，失败或断开时统一清理
	var established []*ssh.Client
	cleanup := func() {
		for _, c := range established {
			_ = c.Close()
		}
	}

	// 第一跳：本机（或经代理）直连最外层跳板机
	first := chain[0]
	firstAddr := joinHostPort(first.Host, first.Port)
	firstAuth, authErr := buildAuthMethods(first.PrivateKey, first.PrivateKeyPassphrase, first.Password, first.Certificate)
	if authErr != nil {
		return nil, apperror.SSHConnectionFailed(
			fmt.Sprintf("invalid credentials for jump host %s", firstAddr), authErr)
	}
	firstClient, err := dialWithProxy("tcp", firstAddr, &ssh.ClientConfig{
		User:            first.Username,
		Auth:            firstAuth,
		HostKeyCallback: s.makeHostKeyCallback(first.Host, first.Port),
		Timeout:         connectionTimeout(config),
	}, config)
	if err != nil {
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to jump host %s", firstAddr), err)
	}
	established = append(established, firstClient)

	// 中间跳：从上一跳穿透到下一跳
	cur := firstClient
	for _, jh := range chain[1:] {
		nextAddr := joinHostPort(jh.Host, jh.Port)
		nextAuth, authErr := buildAuthMethods(jh.PrivateKey, jh.PrivateKeyPassphrase, jh.Password, jh.Certificate)
		if authErr != nil {
			cleanup()
			return nil, apperror.SSHConnectionFailed(
				fmt.Sprintf("invalid credentials for jump host %s", nextAddr), authErr)
		}
		conn, err := dialViaClient(cur, nextAddr, connectionTimeout(config))
		if err != nil {
			cleanup()
			return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to tunnel to jump host %s", nextAddr), err)
		}

		next, err := newSSHClient(conn, nextAddr, &ssh.ClientConfig{
			User:            jh.Username,
			Auth:            nextAuth,
			HostKeyCallback: s.makeHostKeyCallback(jh.Host, jh.Port),
			Timeout:         connectionTimeout(config),
		}, connectionTimeout(config))
		if err != nil {
			cleanup()
			return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to establish SSH to jump host %s", nextAddr), err)
		}

		established = append(established, next)
		cur = next
	}

	// 最后一段：从最内层跳板机穿透到目标
	conn, err := dialViaClient(cur, targetAddr, connectionTimeout(config))
	if err != nil {
		cleanup()
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to tunnel to %s via jump host", targetAddr), err)
	}

	last, err := newSSHClient(conn, targetAddr, targetConfig, connectionTimeout(config))
	if err != nil {
		cleanup()
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to establish SSH via jump host to %s", targetAddr), err)
	}

	targetClient := last

	// 监控目标连接状态，断开时清理整条跳板链
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("jump host monitor panic", "panic", r, "stack", string(debug.Stack()))
			}
		}()
		_ = targetClient.Wait()
		_ = conn.Close()
		cleanup()
	}()

	return targetClient, nil
}

// dialWithProxy 建立 SSH 连接，可选通过 HTTP 或 SOCKS5 代理。
// 如果 config.ProxyType 为空，使用直连 ssh.Dial。
func dialWithProxy(network, addr string, sshConfig *ssh.ClientConfig, config *SSHConnectionConfig) (*ssh.Client, error) {
	dialTimeout := connectionTimeout(config)
	if config.ProxyType == "" {
		conn, err := net.DialTimeout(network, addr, dialTimeout)
		if err != nil {
			return nil, err
		}
		return newSSHClient(conn, addr, sshConfig, dialTimeout)
	}

	proxyAddr := joinHostPort(config.ProxyHost, config.ProxyPort)
	var conn net.Conn

	switch strings.ToLower(config.ProxyType) {
	case "socks5":
		var auth *proxy.Auth
		if config.ProxyUsername != "" {
			auth = &proxy.Auth{User: config.ProxyUsername, Password: config.ProxyPassword}
		}
		d, err := proxy.SOCKS5("tcp", proxyAddr, auth, &netDialer{timeout: dialTimeout})
		if err != nil {
			return nil, fmt.Errorf("failed to create SOCKS5 dialer: %w", err)
		}
		// SOCKS5 拨号无内置超时，用 context 限制总时间
		ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
		defer cancel()
		// proxy.SOCKS5 返回的 dialer 实现了 ContextDialer 接口
		if cd, ok := d.(proxy.ContextDialer); ok {
			conn, err = cd.DialContext(ctx, network, addr)
		} else {
			conn, err = d.Dial(network, addr)
		}
		if err != nil {
			return nil, fmt.Errorf("failed to dial %s through SOCKS5 proxy: %w", addr, err)
		}
	case "http":
		hd := &httpConnectDialer{
			proxyAddr:     proxyAddr,
			proxyUsername: config.ProxyUsername,
			proxyPassword: config.ProxyPassword,
			timeout:       dialTimeout,
		}
		var err error
		conn, err = hd.Dial(network, addr)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported proxy type: %s", config.ProxyType)
	}

	// 与直连一致：握手/认证阶段必须带上 deadline，否则代理隧道已建立但
	// 服务端不响应时会永久阻塞
	return newSSHClient(conn, addr, sshConfig, dialTimeout)
}

// newSSHClient 在已建立的 TCP 连接上完成 SSH 握手与认证，并对握手阶段设置
// 总超时。
//
// x/crypto/ssh 的 ClientConfig.Timeout 只作用于 TCP 拨号：服务端接受连接却
// 不返回 banner、或认证阶段不再响应时，NewClientConn 没有任何 deadline，
// Connect 会永久阻塞并占住 fd/goroutine（用户界面表现为"连接中"永不结束）。
// 这里在握手前设置读写 deadline，成功后立即清除，避免影响后续长连接。
func newSSHClient(conn net.Conn, addr string, sshConfig *ssh.ClientConfig, timeout time.Duration) (*ssh.Client, error) {
	if timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(timeout))
	}
	ncc, chans, reqs, err := ssh.NewClientConn(conn, addr, sshConfig)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("SSH 握手失败（%s）: %w", addr, err)
	}
	if timeout > 0 {
		// 必须清除：否则连接会在 timeout 之后整体读写超时
		_ = conn.SetDeadline(time.Time{})
	}
	return ssh.NewClient(ncc, chans, reqs), nil
}

// dialViaClient 通过已有 SSH 连接打开到 addr 的隧道，并限制等待时长。
// ssh.Client.Dial 没有超时参数：跳板机对目标地址不可达时会在服务端侧长时间
// 挂起，整个连接链因此卡死。超时返回后调用方会关闭已建立的各级连接，
// 从而让阻塞中的 Dial goroutine 一并退出。
func dialViaClient(client *ssh.Client, addr string, timeout time.Duration) (net.Conn, error) {
	type dialResult struct {
		conn net.Conn
		err  error
	}
	ch := make(chan dialResult, 1)
	go func() {
		conn, err := client.Dial("tcp", addr)
		ch <- dialResult{conn: conn, err: err}
	}()
	if timeout <= 0 {
		res := <-ch
		return res.conn, res.err
	}
	select {
	case res := <-ch:
		return res.conn, res.err
	case <-time.After(timeout):
		return nil, fmt.Errorf("通过跳板机连接 %s 超时（%s）", addr, timeout)
	}
}

// netDialer 包装 net.Dialer，实现 proxy.Dialer 的底层网络连接超时控制
type netDialer struct {
	timeout time.Duration
}

func (d *netDialer) Dial(network, addr string) (net.Conn, error) {
	return net.DialTimeout(network, addr, d.timeout)
}

// httpConnectDialer 实现 proxy.Dialer 接口，使用 HTTP CONNECT 方法建立隧道。
type httpConnectDialer struct {
	proxyAddr     string
	proxyUsername string
	proxyPassword string
	timeout       time.Duration
}

func (d *httpConnectDialer) Dial(network, addr string) (net.Conn, error) {
	conn, err := net.DialTimeout(network, d.proxyAddr, d.timeout)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to HTTP proxy %s: %w", d.proxyAddr, err)
	}

	// 设置读写超时，防止代理无响应时无限阻塞
	_ = conn.SetDeadline(time.Now().Add(d.timeout))

	// 使用 bufio.Reader 读取 HTTP 响应，避免 http.ReadResponse 读到 SSH 握手数据
	br := bufio.NewReader(conn)

	reqLine := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
	if d.proxyUsername != "" {
		cred := base64.StdEncoding.EncodeToString([]byte(d.proxyUsername + ":" + d.proxyPassword))
		reqLine += fmt.Sprintf("Proxy-Authorization: Basic %s\r\n", cred)
	}
	reqLine += "\r\n"

	if _, err := conn.Write([]byte(reqLine)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed to send CONNECT request to proxy: %w", err)
	}

	resp, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed to read proxy CONNECT response: %w", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("HTTP proxy %s rejected CONNECT to %s: %s", d.proxyAddr, addr, resp.Status)
	}

	// 清除超时，后续 SSH 握手和数据传输不受限制
	_ = conn.SetDeadline(time.Time{})

	// 包装连接，确保 bufio.Reader 中缓存的 SSH 握手数据不丢失
	return &bufferedConn{Conn: conn, r: br}, nil
}

// bufferedConn 包装 net.Conn 和 bufio.Reader，使 bufio 缓冲的数据可通过 Read 读取。
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.r.Read(p)
}

// buildAuthMethods 构建认证方法列表。
// certificate 为 OpenSSH 用户证书内容：提供时先尝试「证书 + 私钥」签名，
// 再保留原始私钥作为后备（服务器不要求证书时仍可登录）。
func buildAuthMethods(privateKey, passphrase, password, certificate string) ([]ssh.AuthMethod, error) {
	var authMethods []ssh.AuthMethod
	cert := strings.TrimSpace(certificate)
	if cert != "" && privateKey == "" {
		return nil, errors.New("使用 SSH 证书时必须同时配置私钥")
	}

	if privateKey != "" {
		signer, err := ssh.ParsePrivateKey([]byte(privateKey))
		if err != nil && passphrase != "" {
			// 加密私钥：用口令再解析一次。口令错误时保持 err，
			// 仍允许口令认证作为后备（服务器可能同时接受密码）。
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
		}
		if err != nil {
			// 显式配置了证书时，私钥不可用意味着必然无法认证，
			// 直接报错比静默降级为密码更能暴露配置问题。
			if cert != "" {
				return nil, fmt.Errorf("解析私钥失败: %w", err)
			}
			slog.Warn("private key parse failed, falling back to password if available", "error", err)
		} else {
			if cert != "" {
				certSigner, certErr := parseCertificateSigner(signer, cert)
				if certErr != nil {
					return nil, certErr
				}
				authMethods = append(authMethods, ssh.PublicKeys(certSigner))
			}
			authMethods = append(authMethods, ssh.PublicKeys(signer))
		}
	}
	// 密码作为备选认证方式：即使密钥解析成功也添加，
	// 服务器拒绝密钥时 SSH 库会自动尝试下一个认证方法
	if password != "" {
		authMethods = append(authMethods, ssh.Password(password))
	}
	return authMethods, nil
}

// parseCertificateSigner 把用户证书与私钥签名者包装成证书签名者。
// NewCertSigner 会校验证书公钥与私钥是否配对，不匹配时返回错误。
func parseCertificateSigner(key ssh.Signer, certificate string) (ssh.Signer, error) {
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(certificate))
	if err != nil {
		return nil, fmt.Errorf("解析 SSH 证书失败: %w", err)
	}
	cert, ok := pub.(*ssh.Certificate)
	if !ok {
		return nil, errors.New("证书文件内容不是 SSH 用户证书（应以 ssh-*-cert-v01@openssh.com 开头）")
	}
	signer, err := ssh.NewCertSigner(cert, key)
	if err != nil {
		return nil, fmt.Errorf("证书与私钥不匹配: %w", err)
	}
	return signer, nil
}

// authMethods 组装一次连接可用的全部认证方式。
func (s *SshService) authMethods(config *SSHConnectionConfig) ([]ssh.AuthMethod, error) {
	methods, err := buildAuthMethods(config.PrivateKey, config.PrivateKeyPassphrase, config.Password, config.Certificate)
	if err != nil {
		return nil, err
	}
	// keyboard-interactive：部分服务器（尤其是开启 MFA 的）只开放该认证方式，
	// 因此只要存在密码或用户显式开启就加入候选；是否真正弹窗由问题内容决定。
	if config.KeyboardInteractive || config.Password != "" {
		methods = append(methods, s.keyboardInteractiveAuth(config))
	}
	return methods, nil
}

// SetAuthPrompter 注入交互式认证问答通道。
//
//wails:ignore 仅由后端装配（main.go）调用，参数是接口类型无法 JSON 序列化
func (s *SshService) SetAuthPrompter(p AuthPrompter) {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	s.authPrompter = p
}

// SubmitAuthResponses 提交前端填写的交互式认证回答。
// 问答已超时/取消时返回错误，前端据此提示"请求已失效"。
func (s *SshService) SubmitAuthResponses(requestID string, responses []string) error {
	waiter, ok := s.takeAuthWaiter(requestID)
	if !ok {
		return errors.New("交互式认证请求已失效")
	}
	if len(responses) > maxAuthQuestions {
		responses = responses[:maxAuthQuestions]
	}
	trimmed := make([]string, len(responses))
	for i, answer := range responses {
		if len(answer) > maxAuthResponseLen {
			// 按字节截断可能切断多字节字符，把非法 UTF-8 发给服务器。
			// 与提示文本的截断保持一致，回退到完整字符边界。
			answer = truncateUTF8Bytes(answer, maxAuthResponseLen)
		}
		trimmed[i] = answer
	}
	// waiter 带缓冲，无接收者（已被超时逻辑放弃）时直接丢弃，避免阻塞调用方。
	select {
	case waiter <- authAnswer{responses: trimmed}:
	default:
	}
	return nil
}

// CancelAuthPrompt 用户取消交互式认证，使在途连接尽快失败而不是等到超时。
func (s *SshService) CancelAuthPrompt(requestID string) error {
	waiter, ok := s.takeAuthWaiter(requestID)
	if !ok {
		return errors.New("交互式认证请求已失效")
	}
	select {
	case waiter <- authAnswer{canceled: true}:
	default:
	}
	return nil
}

// sessionUsesClient 判断指定会话当前是否仍绑定到该 client。
// 端口转发在 Listen 与登记之间可能与 Disconnect 交错：登记的 listener
// 不会再被 cleanupForwards 看到，必须登记后二次校验并自行回收。
func (s *SshService) sessionUsesClient(sessionID string, client *ssh.Client) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	active, ok := s.sessions[sessionID]
	return ok && active.client == client
}

// isCurrentSession 判断 current 是否仍注册在 sessions 中。
// 用于输出流：会话被 Disconnect 删除、或被同 ID 的新连接替换后，
// 旧管道里尚未发送的数据不得再写入前端（否则旧会话的输出会混进新终端）。
func (s *SshService) isCurrentSession(sessionID string, current *activeSession) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[sessionID] == current
}

// truncateUTF8Bytes 把字符串截到不超过 maxBytes，且不破坏多字节字符。
func truncateUTF8Bytes(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	b := []byte(s)[:maxBytes]
	for len(b) > 0 && !utf8.Valid(b) {
		b = b[:len(b)-1]
	}
	return string(b)
}

// takeAuthWaiter 取出并移除等待者：同一请求只允许一次性回答/取消。
func (s *SshService) takeAuthWaiter(requestID string) (chan authAnswer, bool) {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	waiter, ok := s.authWaiters[requestID]
	if ok {
		delete(s.authWaiters, requestID)
	}
	return waiter, ok
}

// keyboardInteractiveAuth 构造 keyboard-interactive 认证方法。
func (s *SshService) keyboardInteractiveAuth(config *SSHConnectionConfig) ssh.AuthMethod {
	return ssh.KeyboardInteractive(s.keyboardInteractiveChallenge(config))
}

// keyboardInteractiveChallenge 返回处理服务器问答的回调。
// 纯密码问题优先用已保存密码自动回答；其余问题推送到前端弹窗。
func (s *SshService) keyboardInteractiveChallenge(config *SSHConnectionConfig) ssh.KeyboardInteractiveChallenge {
	return func(_ string, instruction string, questions []string, echos []bool) ([]string, error) {
		if len(questions) > maxAuthQuestions {
			questions = questions[:maxAuthQuestions]
		}
		if len(questions) == 0 {
			// 只有提示语、没有输入项：无需用户操作
			return nil, nil
		}

		prompts := make([]AuthPrompt, len(questions))
		for i, question := range questions {
			echo := false
			if i < len(echos) {
				echo = echos[i]
			}
			prompts[i] = AuthPrompt{Prompt: truncatePromptText(question, maxAuthPromptLen), Echo: echo}
		}

		// 单个密码问题：直接复用已保存密码，避免无 MFA 的服务器在仅开
		// keyboard-interactive 时也要用户重复输入一次。
		if len(prompts) == 1 && !prompts[0].Echo && isPasswordPrompt(prompts[0].Prompt) && config.Password != "" {
			return []string{config.Password}, nil
		}

		s.authMu.Lock()
		prompter := s.authPrompter
		s.authMu.Unlock()
		if prompter == nil {
			// 无 UI 通道（如纯后端集成测试）：全部是密码类问题时可用保存的密码回答
			if config.Password != "" && allPasswordPrompts(prompts) {
				answers := make([]string, len(prompts))
				for i := range answers {
					answers[i] = config.Password
				}
				return answers, nil
			}
			return nil, errors.New("服务器要求交互式认证，但当前环境无法显示问答输入")
		}

		requestID := fmt.Sprintf("%s-%d", config.ID, time.Now().UnixNano())
		waiter := make(chan authAnswer, 1)
		s.authMu.Lock()
		s.authWaiters[requestID] = waiter
		s.authMu.Unlock()
		defer func() {
			s.authMu.Lock()
			delete(s.authWaiters, requestID)
			s.authMu.Unlock()
		}()

		prompter.EmitAuthPrompt(AuthPromptRequest{
			RequestID:   requestID,
			SessionID:   config.ID,
			Host:        config.Host,
			Username:    config.Username,
			Instruction: truncatePromptText(instruction, maxAuthInstruction),
			Prompts:     prompts,
		})

		select {
		case answer := <-waiter:
			if answer.canceled {
				return nil, errors.New("用户取消了交互式认证")
			}
			// 前端可能少填（例如关闭了某个输入框），按问题数补齐空串，
			// 服务器通常要求回答数量与问题数量一致。
			responses := make([]string, len(prompts))
			for i := 0; i < len(prompts) && i < len(answer.responses); i++ {
				responses[i] = answer.responses[i]
			}
			return responses, nil
		case <-time.After(authPromptTimeout):
			return nil, fmt.Errorf("交互式认证等待输入超时（%s）", authPromptTimeout)
		}
	}
}

// isPasswordPrompt 判断提示语是否在询问密码/口令。
func isPasswordPrompt(prompt string) bool {
	lower := strings.ToLower(prompt)
	return strings.Contains(lower, "password") ||
		strings.Contains(lower, "passphrase") ||
		strings.Contains(prompt, "密码") ||
		strings.Contains(prompt, "口令")
}

func allPasswordPrompts(prompts []AuthPrompt) bool {
	for _, prompt := range prompts {
		if prompt.Echo || !isPasswordPrompt(prompt.Prompt) {
			return false
		}
	}
	return true
}

// truncatePromptText 按字节截断并保证 UTF-8 合法：
// 服务器返回的提示语可能含中文，直接按字节截断会切坏最后一个字符。
func truncatePromptText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// buildAgentAuthMethod 连接本地 SSH agent 并返回基于 agent 的认证方法和 closer。
// closer 非 nil 时，调用方在认证完成后（dial 返回后）必须调用 Close() 释放资源。
// 如果 agent 不可用或没有密钥，返回 (nil, nil)。
// 在 Windows 上通过命名管道 \\.\pipe\openssh-ssh-agent 连接，
// 在 Unix 上通过 SSH_AUTH_SOCK 环境变量指定的 Unix socket 连接。
func buildAgentAuthMethod() (ssh.AuthMethod, io.Closer) {
	if !sshagent.Available() {
		slog.Debug("SSH agent not available")
		return nil, nil
	}

	ag, closer, err := sshagent.New()
	if err != nil {
		slog.Debug("failed to connect to SSH agent", "error", err)
		return nil, nil
	}

	// PublicKeysCallback 在认证时调用 ag.Signers() 从 agent 获取签名者。
	// Signers 返回的签名者在 Sign() 时会向 agent 发送签名请求，
	// 因此 closer 必须在认证（dial）完成后才能关闭。
	return ssh.PublicKeysCallback(ag.Signers), closer
}

// makeHostKeyCallback returns a callback that enforces Trust-On-First-Use.
func (s *SshService) makeHostKeyCallback(host string, port int) ssh.HostKeyCallback {
	addr := joinHostPort(host, port)
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		s.hostsMu.Lock()
		defer s.hostsMu.Unlock()

		known, err := s.loadKnownHosts()
		if err != nil {
			return fmt.Errorf("could not read known hosts: %w", err)
		}

		marshaled := base64.StdEncoding.EncodeToString(key.Marshal())
		entry := fmt.Sprintf("%s %s %s", addr, key.Type(), marshaled)

		if recorded, ok := known[addr]; ok {
			if recorded == entry {
				return nil
			}
			return fmt.Errorf("SECURITY: host key for %s has changed; possible man-in-the-middle attack. "+
				"If this is intentional (e.g. server reinstall), remove the old entry from %s",
				addr, s.knownHostsPath)
		}

		known[addr] = entry
		if err := s.saveKnownHosts(known); err != nil {
			return fmt.Errorf("SECURITY: failed to persist host key for %s: %w; "+
				"check write permissions for %s",
				addr, err, s.knownHostsPath)
		}
		return nil
	}
}

func (s *SshService) loadKnownHosts() (map[string]string, error) {
	known := make(map[string]string)

	data, err := os.ReadFile(s.knownHostsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return known, nil
		}
		return nil, err
	}

	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, " ", 3)
		if len(parts) != 3 {
			continue
		}
		known[parts[0]] = line
	}
	return known, nil
}

func (s *SshService) saveKnownHosts(known map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(s.knownHostsPath), 0700); err != nil {
		return err
	}

	var b strings.Builder
	addrs := make([]string, 0, len(known))
	for a := range known {
		addrs = append(addrs, a)
	}
	sort.Strings(addrs)
	for _, a := range addrs {
		fmt.Fprintln(&b, known[a])
	}

	tmp := s.knownHostsPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.knownHostsPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// KnownHostEntry 描述一条已固定的主机密钥，供设置界面展示与管理。
type KnownHostEntry struct {
	Address     string `json:"address"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"` // OpenSSH 风格 SHA256 指纹
}

// ListKnownHosts 返回当前固定的主机密钥列表，按地址排序。
func (s *SshService) ListKnownHosts() ([]KnownHostEntry, error) {
	s.hostsMu.Lock()
	defer s.hostsMu.Unlock()

	known, err := s.loadKnownHosts()
	if err != nil {
		return nil, err
	}

	entries := make([]KnownHostEntry, 0, len(known))
	for addr, line := range known {
		parts := strings.SplitN(line, " ", 3)
		if len(parts) != 3 {
			continue
		}
		entries = append(entries, KnownHostEntry{
			Address:     addr,
			KeyType:     parts[1],
			Fingerprint: fingerprintFromBase64(parts[2]),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Address < entries[j].Address })
	return entries, nil
}

// RemoveKnownHost 删除指定地址的主机密钥记录。
//
// 仅在用户确认服务器密钥变更确实可信（如重装系统）后调用；
// 删除后下次连接会重新按 TOFU 固定新密钥。地址不存在时视为已删除，不报错。
func (s *SshService) RemoveKnownHost(address string) error {
	s.hostsMu.Lock()
	defer s.hostsMu.Unlock()

	known, err := s.loadKnownHosts()
	if err != nil {
		return err
	}
	if _, ok := known[address]; !ok {
		return nil
	}
	delete(known, address)
	return s.saveKnownHosts(known)
}

// fingerprintFromBase64 从 base64 编码的公钥 blob 计算 OpenSSH 风格 SHA256 指纹。
// 解码失败时返回空串，由前端展示为"未知指纹"。
func fingerprintFromBase64(encoded string) string {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// latencyProbe 一次在途的延迟探测结果。
type latencyProbe struct {
	done chan struct{}
	ms   int64
	err  error
}

// GetLatency 测量当前会话到服务器的往返时延（毫秒）。
// 复用 SSH 的 keepalive 请求：不额外开辟通道，也不会在远端留下命令痕迹。
func (s *SshService) GetLatency(sessionID string) (int64, error) {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	var client *ssh.Client
	if exists {
		client = active.client
	}
	s.mu.RUnlock()

	if !exists || client == nil {
		return 0, apperror.SSHSessionNotFound()
	}

	start := time.Now()
	// SendRequest 在连接黑洞（半开连接、网络静默丢包）时会一直阻塞在读取
	// 服务器应答上。前端每 10 秒轮询一次，若每次都新建探测 goroutine，
	// 关闭 keepalive 后会无界累积。同一 client 只保留一个在途探测，
	// 其它调用复用同一次结果。
	s.latencyMu.Lock()
	if p, ok := s.latencyProbes[client]; ok {
		s.latencyMu.Unlock()
		select {
		case <-p.done:
			return p.ms, p.err
		case <-time.After(probeTimeout):
			return 0, fmt.Errorf("延迟探测超时（%s）", probeTimeout)
		}
	}
	probe := &latencyProbe{done: make(chan struct{})}
	s.latencyProbes[client] = probe
	s.latencyMu.Unlock()

	go func() {
		var ms int64
		var err error
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("延迟探测 panic: %v", r)
			}
			// 先写结果再 close(done)：等待方收到 done 后读取是安全的
			probe.ms = ms
			probe.err = err
			s.latencyMu.Lock()
			if cur, ok := s.latencyProbes[client]; ok && cur == probe {
				delete(s.latencyProbes, client)
			}
			s.latencyMu.Unlock()
			close(probe.done)
		}()
		_, _, err = client.SendRequest("keepalive@openssh.com", true, nil)
		if err == nil {
			ms = time.Since(start).Milliseconds()
		}
	}()

	select {
	case <-probe.done:
		if probe.err != nil {
			return 0, fmt.Errorf("延迟探测失败: %w", probe.err)
		}
		return probe.ms, nil
	case <-time.After(probeTimeout):
		return 0, fmt.Errorf("延迟探测超时（%s）", probeTimeout)
	}
}

// Input 向指定会话的终端写入数据
func (s *SshService) Input(sessionID string, data string) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	// 前端键盘输入始终是 UTF-8；按会话编码转成远端期望的字节序列。
	payload, err := active.encoding.Encode([]byte(data))
	if err != nil {
		return apperror.Validation("failed to encode terminal input")
	}
	_, err = active.stdin.Write(payload)
	return err
}

// maxInputBase64Bytes 单次二进制输入的解析上限（16MB）。
// ZMODEM 等协议按 8KB 左右的子包发送，正常调用远低于该上限；
// 限制可避免异常调用方一次提交过大内容占用内存。
const maxInputBase64Bytes = 16 << 20

// InputBase64 发送原始字节（ZMODEM 等二进制协议使用）。
// Wails 的字符串参数按 UTF-8 传输，直接把二进制转成字符串会被转码破坏，
// 因此前端先把字节数组编码为 base64，这里解码后原样写入 SSH 通道。
func (s *SshService) InputBase64(sessionID string, dataBase64 string) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return apperror.Validation("invalid base64 payload")
	}
	if len(raw) > maxInputBase64Bytes {
		return apperror.Validation("binary input exceeds limit")
	}
	_, err = active.stdin.Write(raw)
	return err
}

func (s *SshService) Resize(sessionID string, rows, cols int) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	return active.session.WindowChange(rows, cols)
}

// cleanupCloseTimeout 限制清理路径上关闭资源的等待时间。
// SFTP 客户端与远端端口转发监听器的 Close 会等待对端应答；连接处于半开
// 或黑洞状态时可能永久阻塞，进而卡死关闭标签、锁库乃至应用退出。
const cleanupCloseTimeout = 5 * time.Second

// closeResourceWithTimeout 在后台关闭资源，最多等待 cleanupCloseTimeout。
// 超时只记录告警并继续清理：关闭动作仍留在后台，连接最终被回收时会返回。
func closeResourceWithTimeout(label string, closer io.Closer) {
	if closer == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := closer.Close(); err != nil {
			slog.Debug("cleanup close returned error", "resource", label, "error", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(cleanupCloseTimeout):
		slog.Warn("cleanup close timed out", "resource", label)
	}
}

// closeRetiredSFTP 回收会话生命周期内被替换下来的旧 SFTP 客户端。
// 并发关闭并共用一次总超时：逐个串行等待会让会话关闭被旧客户端数量放大，
// 而 Close 在 half-open 连接上可能各自等满超时。
func closeRetiredSFTP(clients []*sftp.Client) {
	if len(clients) == 0 {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		wg.Add(len(clients))
		for _, client := range clients {
			go func(c *sftp.Client) {
				defer wg.Done()
				_ = c.Close()
			}(client)
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(cleanupCloseTimeout):
		slog.Warn("cleanup close timed out", "resource", "retired sftp clients")
	}
}

func (s *SshService) Disconnect(sessionID string) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	if exists {
		delete(s.sessions, sessionID)
	}
	// 连接建立期间被关闭时必须留下取消标记，无论此时是否还挂着旧会话。
	// 旧会话存在时上面已按正常流程清理，但 Connect 尚未执行到注册点：
	// 只依据 exists 判断会让它在稍后把新连接注册进去，用户关掉的标签
	// 于是在后端留下一条无人使用的连接，直到应用退出才释放。
	if _, connecting := s.connecting[sessionID]; connecting {
		s.cancelled[sessionID] = struct{}{}
	}
	s.mu.Unlock()

	if exists {
		// 日志文件不由这里关闭：streamOutput 在管道 EOF 后还要把最后一批输出
		// 落盘，提前关闭会让这段内容静默丢失。关闭管道后 streamOutput 会自行
		// 结束并关闭日志。
		//
		// 关闭顺序很重要：先关管道与 session 让输出流立即结束，再释放连接池引用
		// （最后一个使用者会关闭底层连接，从而打断 SFTP 的阻塞读），然后才清理
		// 端口转发与 SFTP/agent。若先关 SFTP，半开连接上它会无限等待，后面的
		// EmitClosed 永远不会发出，前端标签卡在"已断开"却收不到事件。
		// 转发清理放在释放连接之后：远端转发关闭要向服务器发请求，
		// 连接已断开时它会立即失败返回，不会在半开连接上等满超时。
		if active.pipeCloser != nil {
			_ = active.pipeCloser.Close()
		}
		if active.session != nil {
			_ = active.session.Close()
		}
		if active.connConfig != nil {
			s.releaseClient(active.connConfig, active.client)
		} else if active.client != nil {
			_ = active.client.Close()
		}
		// 清理该会话的所有端口转发监听器
		s.cleanupForwards(sessionID)
		closeResourceWithTimeout("sftp client", active.sftpClient)
		closeRetiredSFTP(active.retiredSFTP)
		closeResourceWithTimeout("ssh agent", active.agentCloser)
		s.emitter.EmitClosed(sessionID)
	}
}

// DisconnectAll 断开所有活跃 SSH 会话（用于 WipeData/LockVault）
func (s *SshService) DisconnectAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	s.mu.Unlock()

	for _, id := range ids {
		s.Disconnect(id)
	}
}

// GetSFTPClient 懒加载 SFTP 客户端，复用现有 SSH 连接
func (s *SshService) GetSFTPClient(sessionID string) (*sftp.Client, error) {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	if exists && active.sftpClient != nil {
		client := active.sftpClient
		s.mu.RUnlock()
		return client, nil
	}
	s.mu.RUnlock()

	if !exists {
		return nil, apperror.SSHSessionNotFound()
	}

	// 在锁外创建：sftp.NewClient 需打开子系统通道并完成协议握手，属于可能长时间
	// 阻塞的网络 I/O。若在持有 s.mu 写锁时执行，一旦服务端无响应，Input/Resize/
	// Disconnect 等所有需要该锁的操作都会一并挂死，用户连"断开"都无法自救。
	client, err := sftp.NewClient(active.client,
		sftp.MaxConcurrentRequestsPerFile(8),
	)
	if err != nil {
		return nil, fmt.Errorf("创建 SFTP 客户端失败: %w", err)
	}

	s.mu.Lock()
	// 二次确认：会话仍在且未被替换，且期间无人抢先创建
	if current, ok := s.sessions[sessionID]; ok && current == active {
		if current.sftpClient == nil {
			current.sftpClient = client
			s.mu.Unlock()
			return client, nil
		}
		existing := current.sftpClient
		s.mu.Unlock()
		_ = client.Close()
		return existing, nil
	}
	s.mu.Unlock()

	// 会话已被移除或替换，丢弃刚创建的客户端
	_ = client.Close()
	return nil, apperror.SSHSessionNotFound()
}

func (s *SshService) ResetSFTPClient(sessionID string) {
	s.mu.Lock()
	var stale *sftp.Client
	if active, exists := s.sessions[sessionID]; exists && active.sftpClient != nil {
		stale = active.sftpClient
		active.sftpClient = nil
	}
	s.mu.Unlock()

	// 在锁外关闭：Close 会发送通道关闭消息，同样可能阻塞
	if stale != nil {
		_ = stale.Close()
	}
}

// AdoptSFTPClient 用新的 SFTP 客户端替换会话中已失效的缓存客户端。
//
// stale 必须仍是当前缓存才会替换（并发下可能已被其他调用更新）。
// 旧客户端不在此关闭：它上面可能仍有并发传输在用，直接关闭会把这些传输
// 一并打断；记入 retiredSFTP，在会话结束时统一回收。返回 false 时调用方应关闭 fresh。
//
//wails:ignore 仅由后端 sftp 服务调用，参数无法 JSON 序列化，不暴露给前端
func (s *SshService) AdoptSFTPClient(sessionID string, stale *sftp.Client, fresh *sftp.Client) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	active, exists := s.sessions[sessionID]
	if !exists || active.sftpClient != stale {
		return false
	}
	active.sftpClient = fresh
	if stale != nil {
		active.retiredSFTP = append(active.retiredSFTP, stale)
	}
	return true
}

// NewSFTPClient 基于会话的 SSH 连接新建一个独立的 SFTP 客户端（不缓存、不共享）。
//
// 供临时性重试使用：会话共享的 SFTP 客户端上可能正有并发传输在进行，
// 直接 Reset 会把它们一并打断；新建独立客户端可隔离重试的影响，
// 调用方负责在使用后关闭它。
//
//wails:ignore 仅由后端 sftp 服务调用，返回 *sftp.Client 无法 JSON 序列化，不暴露给前端
func (s *SshService) NewSFTPClient(sessionID string) (*sftp.Client, error) {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	var sshClient *ssh.Client
	if exists {
		sshClient = active.client
	}
	s.mu.RUnlock()

	if !exists || sshClient == nil {
		return nil, apperror.SSHSessionNotFound()
	}
	return sftp.NewClient(sshClient,
		sftp.MaxConcurrentRequestsPerFile(8),
	)
}

// openCommandSession 在 deadline 前创建 SSH 会话；deadline 为零值表示不超时。
//
// x/crypto/ssh 的 NewSession 不接受 context：连接僵死（服务器不再回应握手）时
// 它会永久阻塞。批量执行命令明明传入了超时，前端却会一直等不到返回。
// 因此把创建放进独立 goroutine，超时后立即返回错误；后台再等它真正返回，
// 并关闭迟到的会话，避免句柄泄漏。
func openCommandSession(client *ssh.Client, deadline time.Time) (*ssh.Session, error) {
	type sessionResult struct {
		session *ssh.Session
		err     error
	}
	results := make(chan sessionResult, 1)
	go func() {
		session, err := client.NewSession()
		results <- sessionResult{session: session, err: err}
	}()

	if deadline.IsZero() {
		r := <-results
		if r.err != nil {
			return nil, fmt.Errorf("创建命令会话失败: %w", r.err)
		}
		return r.session, nil
	}

	remaining := time.Until(deadline)
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case r := <-results:
		if r.err != nil {
			return nil, fmt.Errorf("创建命令会话失败: %w", r.err)
		}
		return r.session, nil
	case <-timer.C:
		go func() {
			if r := <-results; r.session != nil {
				_ = r.session.Close()
			}
		}()
		return nil, fmt.Errorf("创建命令会话超时（%s）", remaining)
	}
}

// ExecCommand 在指定会话的 SSH 连接上执行非交互式命令，返回合并的 stdout+stderr 输出。
// 使用独立的 session（不影响交互式 shell），执行完毕后立即关闭。
// timeout 为 0 表示不超时。
func (s *SshService) ExecCommand(sessionID string, command string, timeout time.Duration) (string, error) {
	return s.ExecCommandLimited(sessionID, command, timeout, maxExecOutputBytes)
}

// ExecCommandLimited 与 ExecCommand 相同，但允许调用方指定输出上限。
//
// 批量执行会同时对多台主机收集输出，默认的 8MB 上限乘以会话数会让内存
// 成倍放大（200 台即 1.6GB）。这类调用通常是查看状态的短命令，收紧上限
// 即可显著降低峰值内存；超限部分会被丢弃并在结果末尾注明已截断。
func (s *SshService) ExecCommandLimited(sessionID string, command string, timeout time.Duration, limit int) (string, error) {
	if limit <= 0 {
		limit = maxExecOutputBytes
	}

	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return "", apperror.SSHSessionNotFound()
	}

	// 超时覆盖整个调用（含创建会话），而不是只约束命令执行阶段
	var deadline time.Time
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}

	session, err := openCommandSession(active.client, deadline)
	if err != nil {
		return "", err
	}

	// 使用 sync.Once 确保 session.Close() 只执行一次，避免并发关闭竞态
	var closeOnce sync.Once
	closeSession := func() { closeOnce.Do(func() { _ = session.Close() }) }
	defer closeSession()

	// 超时控制：通过 context 取消 session
	if !deadline.IsZero() {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return "", fmt.Errorf("命令执行超时（%s）", timeout)
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		defer cancel()
		go func() {
			<-ctx.Done()
			if ctx.Err() == context.DeadlineExceeded {
				// 超时后直接关闭 session，使 CombinedOutput 返回
				// 不调用 session.Signal：它使用 wantReply=true 会阻塞等待服务器响应，
				// 如果服务器无响应（正是超时的原因），Signal 会永久阻塞
				closeSession()
			}
		}()
	}

	// 与 CombinedOutput 等价（stdout/stderr 合并），但输出有硬上限
	out := &cappedBuffer{limit: limit}
	session.Stdout = out
	session.Stderr = out
	err = session.Run(command)
	return out.String(), err
}

// maxExecOutputBytes 限制单条非交互命令收集的输出总量（stdout+stderr 合并）。
// 批量执行会同时收集最多 200 台主机的输出，若某台执行了持续输出的命令
// （如 `yes`、`cat /dev/urandom`），在超时前就会把这些字节全部留在内存里。
// 超过上限后丢弃后续输出，命令仍会正常运行到结束/超时。
const maxExecOutputBytes = 8 << 20

// cappedBuffer 是带硬上限的并发安全缓冲区，实现 io.Writer。
type cappedBuffer struct {
	mu        sync.Mutex
	buf       strings.Builder
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	remaining := c.limit - c.buf.Len()
	if remaining <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		c.buf.Write(p[:remaining])
		c.truncated = true
		return len(p), nil
	}
	c.buf.Write(p)
	return len(p), nil
}

// String 返回已收集的输出；发生过截断时附带一条说明，避免调用方
// 把"只看到前 limit 字节"误当成完整结果。
func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.buf.String()
	if c.truncated {
		out += fmt.Sprintf("\n[输出超过 %d 字节，已截断]\n", c.limit)
	}
	return out
}

// AddPortForward 添加端口转发
func (s *SshService) AddPortForward(spec *PortForwardSpec) error {
	// 同 Connect：spec 为 nil 时下方读取 spec.SessionID 会触发空指针 panic。
	if spec == nil {
		return apperror.Validation("port forward spec is required")
	}
	// ID 是后续 RemovePortForward 的唯一索引，空 ID 会让删除操作无法命中；
	// 端口 0 会绑定随机端口（用户界面仍显示 0，无法实际使用），一并拒绝。
	if strings.TrimSpace(spec.ID) == "" {
		return apperror.Validation("port forward id is required")
	}
	if spec.LocalPort <= 0 || spec.LocalPort > 65535 {
		return apperror.Validation("local port must be between 1 and 65535")
	}
	if spec.RemotePort <= 0 || spec.RemotePort > 65535 {
		return apperror.Validation("remote port must be between 1 and 65535")
	}

	s.mu.RLock()
	active, exists := s.sessions[spec.SessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	// 限制端口转发总数，防止资源耗尽（真正的递增在 start*Forward 的锁内复查，
	// 这里只做快速失败，避免并发请求同时通过检查）
	s.forwardsMu.Lock()
	atLimit := len(s.forwards) >= maxPortForwards
	s.forwardsMu.Unlock()
	if atLimit {
		return fmt.Errorf("端口转发总数已达上限（%d）", maxPortForwards)
	}

	switch spec.Type {
	case "local":
		return s.startLocalForward(spec, active.client)
	case "remote":
		return s.startRemoteForward(spec, active.client)
	default:
		return fmt.Errorf("unsupported forward type: %s", spec.Type)
	}
}

func (s *SshService) startLocalForward(spec *PortForwardSpec, client *ssh.Client) error {
	// 安全加固：LocalHost 为空时默认绑定回环地址 127.0.0.1，
	// 避免 net.Listen("tcp", ":port") 绑定 0.0.0.0 将所有网卡暴露到局域网。
	// 通配地址（0.0.0.0 / ::）明确拒绝：隧道内没有任何鉴权，一旦监听所有网卡，
	// 同网段任何主机都能直通远端服务。需要对外暴露时填写具体网卡地址，
	// 让暴露范围与意图明确（等价于 ssh -g -L 的替代写法）。
	localHost := strings.TrimSpace(spec.LocalHost)
	if localHost == "" {
		localHost = "127.0.0.1"
	}
	// 允许用户填写 IPv6 字面量（含 [::1] 形式）：先去方括号，再用 JoinHostPort
	// 拼接。直接用 "%s:%d" 会让 "::1:8080" 因冒号过多而监听失败。
	localHost = strings.TrimSuffix(strings.TrimPrefix(localHost, "["), "]")
	if ip := net.ParseIP(localHost); ip != nil && ip.IsUnspecified() {
		return fmt.Errorf("本地监听地址 %s 会把隧道暴露给局域网且无鉴权，请填写具体网卡地址（如 192.168.1.10）", spec.LocalHost)
	}
	localAddr := net.JoinHostPort(localHost, strconv.Itoa(spec.LocalPort))
	listener, err := net.Listen("tcp", localAddr)
	if err != nil {
		// 友好提示端口占用
		if strings.Contains(err.Error(), "address already in use") {
			return fmt.Errorf("本地端口 %d 已被占用", spec.LocalPort)
		}
		return fmt.Errorf("监听 %s 失败: %w", localAddr, err)
	}

	s.forwardsMu.Lock()
	// 检查重复 ID，若已存在则关闭新 listener 并返回错误（保留已有转发不动）
	if _, exists := s.forwards[spec.ID]; exists {
		s.forwardsMu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("port forward with ID %s already exists", spec.ID)
	}
	// 与 AddPortForward 的前置检查不同，这里在登记锁内复查上限：
	// 并发请求都通过前置检查时，只有这里的检查能阻止实际数量越界。
	if len(s.forwards) >= maxPortForwards {
		s.forwardsMu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("端口转发总数已达上限（%d）", maxPortForwards)
	}
	s.forwards[spec.ID] = listener
	s.sessionForwards[spec.SessionID] = append(s.sessionForwards[spec.SessionID], spec.ID)
	s.forwardsMu.Unlock()

	// Disconnect 可能已在 Listen 之后、登记之前执行完 cleanupForwards：
	// 这个 listener 不会被任何清理路径看到，必须立即自行回收，
	// 否则本地端口被永久占用、转发计数逐步耗尽。
	if client != nil && !s.sessionUsesClient(spec.SessionID, client) {
		_ = s.RemovePortForward(spec.ID)
		return apperror.SSHSessionNotFound()
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("local forward panic", "spec", spec.ID, "panic", r, "stack", string(debug.Stack()))
			}
		}()
		for {
			localConn, err := listener.Accept()
			if err != nil {
				return
			}

			go func(conn net.Conn) {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("local forward conn panic", "panic", r)
					}
				}()
				defer conn.Close()
				remoteAddr := net.JoinHostPort(spec.RemoteHost, strconv.Itoa(spec.RemotePort))
				remoteConn, err := client.Dial("tcp", remoteAddr)
				if err != nil {
					slog.Error("local forward dial failed", "remote", remoteAddr, "error", err)
					return
				}
				defer remoteConn.Close()

				// 登记双端连接：移除转发时统一关闭，避免隧道与 io.Copy goroutine 泄漏。
				// 若转发已被移除（登记失败），直接返回，defer 会关闭两端连接。
				if !s.trackForwardConn(spec.ID, conn, remoteConn) {
					return
				}
				defer s.untrackForwardConn(spec.ID, conn, remoteConn)

				// 任意方向的 io.Copy 结束时关闭双端，避免单向阻塞泄漏
				var once sync.Once
				closeBoth := func() {
					conn.Close()
					remoteConn.Close()
				}

				go func() {
					defer func() {
						if r := recover(); r != nil {
							slog.Error("local forward io.Copy panic", "panic", r)
						}
					}()
					io.Copy(remoteConn, conn)
					once.Do(closeBoth)
				}()
				io.Copy(conn, remoteConn)
				once.Do(closeBoth)
			}(localConn)
		}
	}()

	return nil
}

func (s *SshService) startRemoteForward(spec *PortForwardSpec, client *ssh.Client) error {
	// 空 RemoteHost 会拼成 ":port"，让 SSH 服务端在 0.0.0.0 上监听，
	// 把端口暴露给远端整个网络。与本地转发一致，默认绑定远端回环地址。
	remoteHost := strings.TrimSpace(spec.RemoteHost)
	if remoteHost == "" {
		remoteHost = "127.0.0.1"
	}
	// 与本地转发一致：支持 IPv6 字面量，方括号由 JoinHostPort 按需补上
	remoteHost = strings.TrimSuffix(strings.TrimPrefix(remoteHost, "["), "]")
	remoteAddr := net.JoinHostPort(remoteHost, strconv.Itoa(spec.RemotePort))
	listener, err := client.Listen("tcp", remoteAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on remote %s: %w", remoteAddr, err)
	}

	s.forwardsMu.Lock()
	// 检查重复 ID，若已存在则关闭新 listener 并返回错误（保留已有转发不动）
	if _, exists := s.forwards[spec.ID]; exists {
		s.forwardsMu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("port forward with ID %s already exists", spec.ID)
	}
	// 同本地转发：在登记锁内复查总数上限，防止并发请求同时越过前置检查
	if len(s.forwards) >= maxPortForwards {
		s.forwardsMu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("端口转发总数已达上限（%d）", maxPortForwards)
	}
	s.forwards[spec.ID] = listener
	s.sessionForwards[spec.SessionID] = append(s.sessionForwards[spec.SessionID], spec.ID)
	s.forwardsMu.Unlock()

	// 同本地转发：登记后确认会话仍然存在，否则立即回收远端监听
	if client != nil && !s.sessionUsesClient(spec.SessionID, client) {
		_ = s.RemovePortForward(spec.ID)
		return apperror.SSHSessionNotFound()
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("remote forward panic", "spec", spec.ID, "panic", r, "stack", string(debug.Stack()))
			}
		}()
		for {
			remoteConn, err := listener.Accept()
			if err != nil {
				return
			}

			go func(conn net.Conn) {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("remote forward conn panic", "panic", r)
					}
				}()
				defer conn.Close()
				localAddr := net.JoinHostPort(spec.LocalHost, strconv.Itoa(spec.LocalPort))
				localConn, err := net.Dial("tcp", localAddr)
				if err != nil {
					slog.Error("remote forward dial failed", "local", localAddr, "error", err)
					return
				}
				defer localConn.Close()

				// 登记双端连接：移除转发时统一关闭，避免隧道与 io.Copy goroutine 泄漏。
				// 若转发已被移除（登记失败），直接返回，defer 会关闭两端连接。
				if !s.trackForwardConn(spec.ID, conn, localConn) {
					return
				}
				defer s.untrackForwardConn(spec.ID, conn, localConn)

				// 任意方向的 io.Copy 结束时关闭双端，避免单向阻塞泄漏
				var once sync.Once
				closeBoth := func() {
					conn.Close()
					localConn.Close()
				}

				go func() {
					defer func() {
						if r := recover(); r != nil {
							slog.Error("remote forward io.Copy panic", "panic", r)
						}
					}()
					io.Copy(localConn, conn)
					once.Do(closeBoth)
				}()
				io.Copy(conn, localConn)
				once.Do(closeBoth)
			}(remoteConn)
		}
	}()

	return nil
}

// RemovePortForward 移除并停止端口转发
func (s *SshService) RemovePortForward(forwardID string) error {
	s.forwardsMu.Lock()
	listener, ok := s.forwards[forwardID]
	if ok {
		delete(s.forwards, forwardID)
	}
	// 从 sessionForwards 反向索引中移除
	for sid, ids := range s.sessionForwards {
		for i, id := range ids {
			if id == forwardID {
				s.sessionForwards[sid] = append(ids[:i], ids[i+1:]...)
				if len(s.sessionForwards[sid]) == 0 {
					delete(s.sessionForwards, sid)
				}
				break
			}
		}
	}
	s.forwardsMu.Unlock()

	if ok && listener != nil {
		closeResourceWithTimeout("port forward listener", listener)
	}
	// 关闭该转发已建立的隧道连接：仅关 listener 不会关闭已 Accept 的连接，
	// 否则"已删除"的转发仍会继续传输并泄漏 fd/goroutine
	s.closeForwardConns(forwardID)
	return nil
}

// cleanupForwards 清理指定会话的所有端口转发监听器
func (s *SshService) cleanupForwards(sessionID string) {
	forwardIDs, listeners := s.detachForwardsLocked(sessionID)
	s.closeForwardListeners(sessionID, forwardIDs, listeners)
}

// detachForwardsLocked 从转发登记表中摘除指定会话的全部转发并返回监听器。
//
// 调用方可以持有 s.mu（Connect 替换会话时需要与安装新会话原子完成），
// 因此本函数只做内存操作，不关闭 listener：Close 远端转发会等待服务器应答，
// 不能在任何锁内执行。
func (s *SshService) detachForwardsLocked(sessionID string) ([]string, []net.Listener) {
	s.forwardsMu.Lock()
	forwardIDs := s.sessionForwards[sessionID]
	delete(s.sessionForwards, sessionID)
	var listeners []net.Listener
	for _, id := range forwardIDs {
		if listener, ok := s.forwards[id]; ok {
			delete(s.forwards, id)
			listeners = append(listeners, listener)
		}
	}
	s.forwardsMu.Unlock()
	return forwardIDs, listeners
}

// closeForwardListeners 关闭已摘除的转发监听器并释放其隧道连接。
// 远端转发的 listener.Close 会向服务器发送 cancel-tcpip-forward 并等待应答，
// 半开连接上可能永久阻塞。每个 listener 独立并发关闭：串行关闭时只要
// 第一个卡住，后续 listener 在超时后仍未关闭，端口会一直被占用。
func (s *SshService) closeForwardListeners(sessionID string, forwardIDs []string, listeners []net.Listener) {
	if len(listeners) > 0 {
		done := make(chan struct{})
		go func() {
			defer close(done)
			var wg sync.WaitGroup
			wg.Add(len(listeners))
			for _, listener := range listeners {
				go func(l net.Listener) {
					defer wg.Done()
					_ = l.Close()
				}(listener)
			}
			wg.Wait()
		}()
		select {
		case <-done:
		case <-time.After(cleanupCloseTimeout):
			slog.Warn("closing port forward listeners timed out", "session", sessionID)
		}
	}
	// 一并关闭这些转发的活跃隧道连接，否则仅关 listener 会留下仍在传输的
	// 连接和 io.Copy goroutine，直到对端断开为止
	for _, id := range forwardIDs {
		s.closeForwardConns(id)
	}
}

// trackForwardConn 登记某个转发当前活跃的隧道连接。
//
// 返回 false 表示该转发已被移除（cleanupForwards 先删 forwards 条目、
// closeForwardConns 才清空连接表；这段窗口里刚建立完成的连接若直接登记，
// 会落在已经清理过的表里，从此无人关闭）。调用方应放弃该连接。
func (s *SshService) trackForwardConn(forwardID string, conns ...net.Conn) bool {
	s.forwardsMu.Lock()
	defer s.forwardsMu.Unlock()
	if _, exists := s.forwards[forwardID]; !exists {
		return false
	}
	if s.forwardConns[forwardID] == nil {
		s.forwardConns[forwardID] = make(map[net.Conn]struct{})
	}
	for _, c := range conns {
		s.forwardConns[forwardID][c] = struct{}{}
	}
	return true
}

// untrackForwardConn 从登记表中移除已结束的连接
func (s *SshService) untrackForwardConn(forwardID string, conns ...net.Conn) {
	s.forwardsMu.Lock()
	if m, ok := s.forwardConns[forwardID]; ok {
		for _, c := range conns {
			delete(m, c)
		}
		if len(m) == 0 {
			delete(s.forwardConns, forwardID)
		}
	}
	s.forwardsMu.Unlock()
}

// closeForwardConns 关闭并移除某个转发的全部活跃连接。
//
// net.Listener.Close 不会关闭已 Accept 的连接，必须显式关闭，否则隧道与其
// io.Copy goroutine 会一直存活到对端断开——表现为"移除转发后仍在传输"，
// 并持续泄漏 fd 与 goroutine。
func (s *SshService) closeForwardConns(forwardID string) {
	s.forwardsMu.Lock()
	m := s.forwardConns[forwardID]
	delete(s.forwardConns, forwardID)
	conns := make([]net.Conn, 0, len(m))
	for c := range m {
		conns = append(conns, c)
	}
	s.forwardsMu.Unlock()

	// 在锁外关闭，避免 Close 阻塞时占用 forwardsMu
	for _, c := range conns {
		_ = c.Close()
	}
}

func (s *SshService) streamOutput(sessionID string, stdout io.Reader, current *activeSession) {
	// 带缓冲的 channel。提前声明，以便 panic 恢复路径也能访问并排空它。
	dataChan := make(chan []byte, 4)

	defer func() {
		if r := recover(); r != nil {
			slog.Error("streamOutput panic", "session", sessionID, "panic", r, "stack", string(debug.Stack()))
			// 异常退出后本函数不再消费 dataChan：readOutput 会在缓冲填满后永久
			// 阻塞在发送上，导致其 goroutine 泄漏。这里主动排空，直到 readOutput
			// 因 stdout 结束（cleanupSession 关闭管道写端触发 EOF）而关闭该 channel。
			go func() {
				for range dataChan {
				}
			}()
			func() {
				defer func() { recover() }()
				s.cleanupSession(sessionID, current)
			}()
		}
	}()

	buf := make([]byte, 32*1024)

	go readOutput(stdout, buf, dataChan)

	batchDelay := time.Second / time.Duration(batchRatePerSecond)
	ticker := time.NewTicker(batchDelay)
	defer ticker.Stop()

	batchSize := 128 * 1024
	batch := make([]byte, 0, batchSize)

	for {
		select {
		case chunk, ok := <-dataChan:
			if !ok {
				if len(batch) > 0 {
					if s.isCurrentSession(sessionID, current) {
						s.emitter.EmitData(sessionID, batch)
					}
					s.writeLog(current, batch)
				}
				// 先关闭日志再清理会话：Disconnect/替换会话时不再提前关闭日志，
				// 否则最后一批（最多 128KB）输出会因写入已关闭的文件而丢失。
				current.closeLogFile()
				s.cleanupSession(sessionID, current)
				return
			}

			batch = append(batch, chunk...)

			if len(batch) >= batchSize {
				if s.isCurrentSession(sessionID, current) {
					s.emitter.EmitData(sessionID, batch)
				}
				s.writeLog(current, batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				if s.isCurrentSession(sessionID, current) {
					s.emitter.EmitData(sessionID, batch)
				}
				s.writeLog(current, batch)
				batch = batch[:0]
			}
		}
	}
}

// writeLog 将会话输出写入日志文件（如果已启用）。
// 句柄的读取与关闭都必须持有 logMu：closeLogFile 会把 logFile 置空，
// 无锁读取该字段与并发关闭构成数据竞争。
func (s *SshService) writeLog(active *activeSession, data []byte) {
	if active == nil {
		return
	}
	active.logMu.Lock()
	f := active.logFile
	if f == nil {
		active.logMu.Unlock()
		return
	}
	_, err := f.Write(data)
	active.logMu.Unlock()
	if err != nil {
		slog.Debug("failed to write to session log", "error", err)
	}
}

func readOutput(stdout io.Reader, buf []byte, dataChan chan []byte) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("readOutput panic", "panic", r, "stack", string(debug.Stack()))
			close(dataChan)
		}
	}()
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			dataChan <- chunk
		}
		if err != nil {
			close(dataChan)
			return
		}
	}
}

func (s *SshService) cleanupSession(sessionID string, current *activeSession) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	if exists && active == current {
		delete(s.sessions, sessionID)
		s.mu.Unlock()

		current.closeLogFile()
		// 与 Disconnect 相同的顺序：先结束输出与 session、释放连接池引用，
		// 再清理端口转发并对有超时风险的 SFTP/agent 做有界关闭，
		// 避免清理流程在连接半开时永久阻塞。
		if current.pipeCloser != nil {
			_ = current.pipeCloser.Close()
		}
		if current.session != nil {
			_ = current.session.Close()
		}
		if current.connConfig != nil {
			s.releaseClient(current.connConfig, current.client)
		} else if current.client != nil {
			_ = current.client.Close()
		}
		// 清理该会话的所有端口转发监听器
		s.cleanupForwards(sessionID)
		closeResourceWithTimeout("sftp client", current.sftpClient)
		closeResourceWithTimeout("ssh agent", current.agentCloser)
		s.emitter.EmitClosed(sessionID)
	} else {
		s.mu.Unlock()
	}
}
