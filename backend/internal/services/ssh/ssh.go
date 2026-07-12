package ssh

import (
	"bufio"
	"context"
	"encoding/base64"
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
	"time"

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

type SSHConnectionConfig struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
	// JumpHost 跳板机配置（可选），通过跳板机建立到目标的 SSH 隧道
	JumpHost *JumpHostConfig `json:"jumpHost,omitempty"`

	// Proxy 代理配置（可选）
	ProxyType     string `json:"proxyType,omitempty"`     // "http" | "socks5" | "" (无代理)
	ProxyHost     string `json:"proxyHost,omitempty"`
	ProxyPort     int    `json:"proxyPort,omitempty"`
	ProxyUsername string `json:"proxyUsername,omitempty"`
	ProxyPassword string `json:"proxyPassword,omitempty"`

	// AgentForwarding 启用 SSH Agent 认证与转发（可选）
	AgentForwarding bool `json:"agentForwarding,omitempty"`
}

// JumpHostConfig 跳板机配置
type JumpHostConfig struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
}

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
	client     *ssh.Client
	session    *ssh.Session
	stdin      io.WriteCloser
	stdout     io.Reader
	pipeCloser io.Closer
	sftpClient *sftp.Client            // 懒加载，首次使用时创建
	connConfig *SSHConnectionConfig    // 保存配置用于连接池释放
	logFile    *os.File                // 会话日志文件（可选）
	logMu      sync.Mutex              // 保护 logFile 的并发写入
	agentCloser io.Closer              // SSH Agent 转发连接（可选，清理时关闭）
}

type SshService struct {
	emitter  SSHEmitter
	mu       sync.RWMutex
	sessions map[string]*activeSession

	// knownHostsPath is the location of the known_hosts file used for
	// Trust-On-First-use host key verification. Storing pinned host keys
	// prevents man-in-the-middle attacks on subsequent connections.
	knownHostsPath string
	hostsMu        sync.Mutex

	// 连接池：按 connKey 复用 *ssh.Client，多个 session 共享同一 SSH 连接
	connPool   map[string]*pooledConn
	connPoolMu sync.Mutex

	// 端口转发管理
	forwards   map[string]net.Listener // key = forward ID
	forwardsMu sync.Mutex

	// sessionID → forwardID[] 反向索引，用于会话断开时批量清理端口转发
	sessionForwards map[string][]string

	// logDir 会话日志输出目录（空则不记录日志）
	logDir string
}

// pooledConn 池化 SSH 连接，引用计数管理生命周期
type pooledConn struct {
	client   *ssh.Client
	refCount int
	poisoned bool // 标记为死连接，新 acquire 跳过，refCount 归零时删除
}

const timeout = 15 * time.Second

const batchRatePerSecond = 60

func NewSshService(emitter SSHEmitter, logDir string) *SshService {
	return &SshService{
		emitter:         emitter,
		sessions:        make(map[string]*activeSession),
		knownHostsPath:  defaultKnownHostsPath(),
		connPool:        make(map[string]*pooledConn),
		forwards:        make(map[string]net.Listener),
		sessionForwards: make(map[string][]string),
		logDir:          logDir,
	}
}

func defaultKnownHostsPath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "Terminator", "known_hosts")
	}
	return "known_hosts"
}

// Connect establishes an SSH session with connection pooling and optional Jump Host support.
//
// 连接复用：同一 host:port:user 的多个 session 共享 *ssh.Client（引用计数）
// Jump Host：通过跳板机建立 TCP 隧道，再在隧道上建立到目标的 SSH 连接
func (s *SshService) Connect(config *SSHConnectionConfig) error {
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

	if err = session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
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
		if ag, ac, agentErr := sshagent.New(); agentErr == nil {
			if ferr := agent.ForwardToAgent(client, ag); ferr != nil {
				_ = ac.Close()
				slog.Debug("failed to set up agent forwarding on client", "session", config.ID, "error", ferr)
			} else {
				agentCloser = ac // 保存 closer，会话结束时关闭
			}
		} else {
			slog.Debug("SSH agent not available for forwarding", "session", config.ID, "error", agentErr)
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
		s.releaseClient(config, client)
		return apperror.SSHConnectionFailed("failed to start shell", err)
	}

	// 会话日志：如果配置了 logDir，为该会话创建日志文件
	var logFile *os.File
	if s.logDir != "" {
		logPath := filepath.Join(s.logDir, fmt.Sprintf("%s.log", config.ID))
		logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			slog.Warn("failed to create session log file, continuing without logging", "path", logPath, "error", err)
			logFile = nil
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
		go func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("keepalive goroutine panic", "panic", r, "stack", string(debug.Stack()))
				}
			}()
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-keepaliveDone:
					return
				case <-ticker.C:
					if !isConnectionAlive(client) {
						slog.Warn("SSH keepalive failed, closing session", "session", config.ID)
						_ = session.Close()
						_ = pw.Close()
						return
					}
				}
			}
		}()

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
		logFile:     logFile,
		agentCloser: agentCloser,
	}
	s.sessions[config.ID] = currentSession
	s.mu.Unlock()

	if old != nil {
		if old.logFile != nil {
			_ = old.logFile.Close()
		}
		if old.agentCloser != nil {
			_ = old.agentCloser.Close()
		}
		if old.sftpClient != nil {
			_ = old.sftpClient.Close()
		}
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
	}

	go s.streamOutput(config.ID, pr, currentSession)

	return nil
}

// connKey 生成连接池的键
func connKey(config *SSHConnectionConfig) string {
	base := fmt.Sprintf("%s:%d:%s", config.Host, config.Port, config.Username)
	if config.JumpHost != nil {
		base += fmt.Sprintf("->%s:%d:%s", config.JumpHost.Host, config.JumpHost.Port, config.JumpHost.Username)
	}
	if config.ProxyType != "" {
		base += fmt.Sprintf("@proxy:%s:%s:%d", config.ProxyType, config.ProxyHost, config.ProxyPort)
	}
	return base
}

// isConnectionAlive 发送 keepalive 请求检测连接是否存活
// 3 秒超时，避免阻塞太久
// 注意：超时后不关闭 client，因为 client 可能是连接池中的共享连接
// 由调用方决定如何处理（关闭 session 而非 client）
func isConnectionAlive(client *ssh.Client) bool {
	done := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("keepalive panic: %v", r)
			}
		}()
		_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(3 * time.Second):
		// 超时仅返回 false，不关闭共享 client
		// 调用方（keepalive goroutine）会关闭自己的 session
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

		if isConnectionAlive(client) {
			s.connPoolMu.Lock()
			// 二次确认池中条目未被其他 goroutine 移除
			if pc2, ok := s.connPool[key]; ok && pc2.client == client {
				pc2.refCount++
				s.connPoolMu.Unlock()
				return client, nil
			}
			s.connPoolMu.Unlock()
		} else {
			// 连接已死，从池中移除。
			// refCount>0 时不删除条目，仅标记为 poisoned，让 acquire 跳过
			// releaseClient 继续递减 refCount，归零时才关闭和删除
			var shouldClose bool
			s.connPoolMu.Lock()
			if pc2, ok := s.connPool[key]; ok && pc2.client == client {
				if pc2.refCount <= 0 {
					delete(s.connPool, key)
					shouldClose = true
				} else {
					// 标记为 poisoned，新 acquire 会跳过此条目
					pc2.poisoned = true
				}
			}
			s.connPoolMu.Unlock()
			if shouldClose {
				_ = client.Close()
			}
		}
	} else {
		s.connPoolMu.Unlock()
	}

	client, err := s.dialSSH(config)
	if err != nil {
		return nil, err
	}

	s.connPoolMu.Lock()
	if pc, ok := s.connPool[key]; ok && pc.client != nil && !pc.poisoned {
		_ = client.Close()
		pc.refCount++
		client = pc.client
	} else {
		s.connPool[key] = &pooledConn{client: client, refCount: 1}
	}
	s.connPoolMu.Unlock()

	return client, nil
}

// releaseClient 释放连接池引用。
// 传入 client 参数确保只递减/关闭该特定连接，避免按 key 操作时
// 误关池中已被替换的新连接。
func (s *SshService) releaseClient(config *SSHConnectionConfig, client *ssh.Client) {
	key := connKey(config)

	s.connPoolMu.Lock()
	pc, ok := s.connPool[key]
	if !ok || pc.client != client {
		// 池中条目已被替换或移除（如健康检查剔除了死连接），
		// 直接关闭传入的 client 即可
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
	authMethods := buildAuthMethods(config.PrivateKey, config.Password)

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
		Timeout:         timeout,
	}

	targetAddr := fmt.Sprintf("%s:%d", config.Host, config.Port)

	if config.JumpHost != nil {
		return s.dialThroughJumpHost(config, clientConfig, targetAddr)
	}

	client, err := dialWithProxy("tcp", targetAddr, clientConfig, config)
	if err != nil {
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to %s", targetAddr), err)
	}
	return client, nil
}

// dialThroughJumpHost 通过跳板机建立 SSH 隧道
func (s *SshService) dialThroughJumpHost(config *SSHConnectionConfig, targetConfig *ssh.ClientConfig, targetAddr string) (*ssh.Client, error) {
	jh := config.JumpHost
	jumpAddr := fmt.Sprintf("%s:%d", jh.Host, jh.Port)

	jumpAuth := buildAuthMethods(jh.PrivateKey, jh.Password)
	jumpCallback := s.makeHostKeyCallback(jh.Host, jh.Port)

	jumpConfig := &ssh.ClientConfig{
		User:            jh.Username,
		Auth:            jumpAuth,
		HostKeyCallback: jumpCallback,
		Timeout:         timeout,
	}

	// 跳板机连接也通过代理（如果配置了代理）
	jumpClient, err := dialWithProxy("tcp", jumpAddr, jumpConfig, config)
	if err != nil {
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to jump host %s", jumpAddr), err)
	}

	conn, err := jumpClient.Dial("tcp", targetAddr)
	if err != nil {
		_ = jumpClient.Close()
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to tunnel to %s via jump host", targetAddr), err)
	}

	ncc, chans, reqs, err := ssh.NewClientConn(conn, targetAddr, targetConfig)
	if err != nil {
		_ = conn.Close()
		_ = jumpClient.Close()
		return nil, apperror.SSHConnectionFailed(fmt.Sprintf("failed to establish SSH via jump host to %s", targetAddr), err)
	}

	targetClient := ssh.NewClient(ncc, chans, reqs)

	// 监控目标连接状态，断开时清理跳板机资源
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("jump host monitor panic", "panic", r, "stack", string(debug.Stack()))
			}
		}()
		_ = targetClient.Wait()
		_ = conn.Close()
		_ = jumpClient.Close()
	}()

	return targetClient, nil
}

// dialWithProxy 建立 SSH 连接，可选通过 HTTP 或 SOCKS5 代理。
// 如果 config.ProxyType 为空，使用直连 ssh.Dial。
func dialWithProxy(network, addr string, sshConfig *ssh.ClientConfig, config *SSHConnectionConfig) (*ssh.Client, error) {
	if config.ProxyType == "" {
		return ssh.Dial(network, addr, sshConfig)
	}

	proxyAddr := fmt.Sprintf("%s:%d", config.ProxyHost, config.ProxyPort)
	var conn net.Conn

	switch strings.ToLower(config.ProxyType) {
	case "socks5":
		var auth *proxy.Auth
		if config.ProxyUsername != "" {
			auth = &proxy.Auth{User: config.ProxyUsername, Password: config.ProxyPassword}
		}
		d, err := proxy.SOCKS5("tcp", proxyAddr, auth, &netDialer{timeout: timeout})
		if err != nil {
			return nil, fmt.Errorf("failed to create SOCKS5 dialer: %w", err)
		}
		// SOCKS5 拨号无内置超时，用 context 限制总时间
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
		}
		var err error
		conn, err = hd.Dial(network, addr)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported proxy type: %s", config.ProxyType)
	}

	ncc, chans, reqs, err := ssh.NewClientConn(conn, addr, sshConfig)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("failed to establish SSH to %s through proxy: %w", addr, err)
	}

	return ssh.NewClient(ncc, chans, reqs), nil
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
}

func (d *httpConnectDialer) Dial(network, addr string) (net.Conn, error) {
	conn, err := net.DialTimeout(network, d.proxyAddr, timeout)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to HTTP proxy %s: %w", d.proxyAddr, err)
	}

	// 设置读写超时，防止代理无响应时无限阻塞
	_ = conn.SetDeadline(time.Now().Add(timeout))

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

// buildAuthMethods 构建认证方法列表
func buildAuthMethods(privateKey, password string) []ssh.AuthMethod {
	var authMethods []ssh.AuthMethod
	if privateKey != "" {
		signer, err := ssh.ParsePrivateKey([]byte(privateKey))
		if err == nil {
			authMethods = append(authMethods, ssh.PublicKeys(signer))
		} else {
			slog.Warn("private key parse failed, falling back to password if available", "error", err)
		}
	}
	if password != "" && len(authMethods) == 0 {
		authMethods = append(authMethods, ssh.Password(password))
	}
	return authMethods
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
	addr := fmt.Sprintf("%s:%d", host, port)
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
	return os.Rename(tmp, s.knownHostsPath)
}

func (s *SshService) Input(sessionID string, data string) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	_, err := active.stdin.Write([]byte(data))
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

func (s *SshService) Disconnect(sessionID string) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	if exists {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()

	if exists {
		// 清理该会话的所有端口转发监听器
		s.cleanupForwards(sessionID)
		if active.logFile != nil {
			_ = active.logFile.Close()
		}
		if active.agentCloser != nil {
			_ = active.agentCloser.Close()
		}
		if active.sftpClient != nil {
			_ = active.sftpClient.Close()
		}
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

	s.mu.Lock()
	defer s.mu.Unlock()
	active, exists = s.sessions[sessionID]
	if !exists {
		return nil, apperror.SSHSessionNotFound()
	}
	if active.sftpClient != nil {
		return active.sftpClient, nil
	}
	client, err := sftp.NewClient(active.client,
		sftp.MaxConcurrentRequestsPerFile(8),
	)
	if err != nil {
		return nil, fmt.Errorf("创建 SFTP 客户端失败: %w", err)
	}
	active.sftpClient = client
	return client, nil
}

func (s *SshService) ResetSFTPClient(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if active, exists := s.sessions[sessionID]; exists && active.sftpClient != nil {
		active.sftpClient.Close()
		active.sftpClient = nil
	}
}

// ExecCommand 在指定会话的 SSH 连接上执行非交互式命令，返回合并的 stdout+stderr 输出。
// 使用独立的 session（不影响交互式 shell），执行完毕后立即关闭。
// timeout 为 0 表示不超时。
func (s *SshService) ExecCommand(sessionID string, command string, timeout time.Duration) (string, error) {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return "", apperror.SSHSessionNotFound()
	}

	session, err := active.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("创建命令会话失败: %w", err)
	}

	// 使用 sync.Once 确保 session.Close() 只执行一次，避免并发关闭竞态
	var closeOnce sync.Once
	closeSession := func() { closeOnce.Do(func() { _ = session.Close() }) }
	defer closeSession()

	// 超时控制：通过 context 取消 session
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
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

	output, err := session.CombinedOutput(command)
	if err != nil {
		return string(output), err
	}
	return string(output), nil
}

// AddPortForward 添加端口转发
func (s *SshService) AddPortForward(spec *PortForwardSpec) error {
	s.mu.RLock()
	active, exists := s.sessions[spec.SessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	// 限制端口转发总数，防止资源耗尽
	s.forwardsMu.Lock()
	if len(s.forwards) >= 100 {
		s.forwardsMu.Unlock()
		return fmt.Errorf("端口转发总数已达上限（100）")
	}
	s.forwardsMu.Unlock()

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
	localAddr := fmt.Sprintf("%s:%d", spec.LocalHost, spec.LocalPort)
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
	s.forwards[spec.ID] = listener
	s.sessionForwards[spec.SessionID] = append(s.sessionForwards[spec.SessionID], spec.ID)
	s.forwardsMu.Unlock()

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
	remoteAddr := fmt.Sprintf("%s:%d", spec.RemoteHost, spec.RemotePort)
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
	s.forwards[spec.ID] = listener
	s.sessionForwards[spec.SessionID] = append(s.sessionForwards[spec.SessionID], spec.ID)
	s.forwardsMu.Unlock()

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
		_ = listener.Close()
	}
	return nil
}

// cleanupForwards 清理指定会话的所有端口转发监听器
func (s *SshService) cleanupForwards(sessionID string) {
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

	for _, listener := range listeners {
		_ = listener.Close()
	}
}

func (s *SshService) streamOutput(sessionID string, stdout io.Reader, current *activeSession) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("streamOutput panic", "session", sessionID, "panic", r, "stack", string(debug.Stack()))
			func() {
				defer func() { recover() }()
				s.cleanupSession(sessionID, current)
			}()
		}
	}()

	buf := make([]byte, 32*1024)
	// 带缓冲的 channel，防止 streamOutput panic 时 readOutput 阻塞在发送上导致 goroutine 泄漏
	dataChan := make(chan []byte, 4)

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
					s.emitter.EmitData(sessionID, batch)
					s.writeLog(current, batch)
				}
				s.cleanupSession(sessionID, current)
				return
			}

			batch = append(batch, chunk...)

			if len(batch) >= batchSize {
				s.emitter.EmitData(sessionID, batch)
				s.writeLog(current, batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				s.emitter.EmitData(sessionID, batch)
				s.writeLog(current, batch)
				batch = batch[:0]
			}
		}
	}
}

// writeLog 将会话输出写入日志文件（如果已启用）。
// 使用 activeSession.logMu 保护并发写入。
func (s *SshService) writeLog(active *activeSession, data []byte) {
	if active == nil || active.logFile == nil {
		return
	}
	active.logMu.Lock()
	defer active.logMu.Unlock()
	if _, err := active.logFile.Write(data); err != nil {
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

		// 清理该会话的所有端口转发监听器
		s.cleanupForwards(sessionID)
		if current.logFile != nil {
			_ = current.logFile.Close()
		}
		if current.agentCloser != nil {
			_ = current.agentCloser.Close()
		}
		if current.sftpClient != nil {
			_ = current.sftpClient.Close()
		}
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
		s.emitter.EmitClosed(sessionID)
	} else {
		s.mu.Unlock()
	}
}
