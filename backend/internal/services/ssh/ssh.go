package ssh

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"terminator-desktop/backend/internal/apperror"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
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
}

type activeSession struct {
	client     *ssh.Client
	session    *ssh.Session
	stdin      io.WriteCloser
	stdout     io.Reader
	pipeCloser io.Closer
	sftpClient *sftp.Client // 懒加载，首次使用时创建
}

type SshService struct {
	emitter  SSHEmitter
	mu       sync.RWMutex
	sessions map[string]*activeSession

	// knownHostsPath is the location of the known_hosts file used for
	// Trust-On-First-Use host key verification. Storing pinned host keys
	// prevents man-in-the-middle attacks on subsequent connections.
	knownHostsPath string
	hostsMu        sync.Mutex
}

// TODO: configurable timeout?
const timeout = 15 * time.Second

const batchRatePerSecond = 60

func NewSshService(emitter SSHEmitter) *SshService {
	return &SshService{
		emitter:        emitter,
		sessions:       make(map[string]*activeSession),
		knownHostsPath: defaultKnownHostsPath(),
	}
}

// defaultKnownHostsPath resolves a known_hosts file inside the user's
// per-app config directory. It never fails: if the directory cannot be
// resolved the file is placed next to nothing and verification falls back
// to per-session TOFU without persistence.
func defaultKnownHostsPath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "Terminator", "known_hosts")
	}
	return "known_hosts"
}

// Connect establishes an SSH session.
//
// Security note: host keys are verified using a Trust-On-First-Use policy.
// The first connection to a host records its public key; any later
// connection whose key differs is rejected as a potential man-in-the-middle.
// This replaces the previous ssh.InsecureIgnoreHostKey() call which
// silently accepted every key and left connections wide open to MITM.
func (s *SshService) Connect(config *SSHConnectionConfig) error {
	var authMethods []ssh.AuthMethod

	if config.PrivateKey != "" {
		signer, err := ssh.ParsePrivateKey([]byte(config.PrivateKey))
		if err != nil {
			return apperror.DecryptionFailed(err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	} else if config.Password != "" {
		authMethods = append(authMethods, ssh.Password(config.Password))
	}

	hostKeyCallback := s.makeHostKeyCallback(config.Host, config.Port)

	clientConfig := &ssh.ClientConfig{
		User:            config.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         timeout,
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		return apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to %s", addr), err)
	}

	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return apperror.SSHConnectionFailed("failed to create session", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return err
	}

	// Use a pipe so both stdout and stderr feed into the same reader,
	// ensuring the remote error stream is not silently discarded.
	pr, pw := io.Pipe()
	session.Stdout = pw
	session.Stderr = pw

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200, // baud rate
		ssh.TTY_OP_OSPEED: 115200,
	}

	// 24x80 is just the default
	if err = session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		_ = session.Close()
		_ = client.Close()
		return apperror.SSHConnectionFailed("failed to request PTY", err)
	}

	if err = session.Shell(); err != nil {
		_ = session.Close()
		_ = client.Close()
		return apperror.SSHConnectionFailed("failed to start shell", err)
	}

	s.mu.Lock()
	// 清理同 ID 的旧 session，防止资源泄漏
	if old, exists := s.sessions[config.ID]; exists {
		s.mu.Unlock()
		s.cleanupSession(config.ID, old)
		s.mu.Lock()
	}
	currentSession := &activeSession{
		client:     client,
		session:    session,
		stdin:      stdin,
		stdout:     pr,
		pipeCloser: pw,
	}
	s.sessions[config.ID] = currentSession
	s.mu.Unlock()

	go s.streamOutput(config.ID, pr, currentSession)

	return nil
}

// makeHostKeyCallback returns a callback that enforces Trust-On-First-Use.
// On the first connection the host key is recorded to the known_hosts file;
// on every subsequent connection the presented key must match the recorded
// one or the connection is rejected.
func (s *SshService) makeHostKeyCallback(host string, port int) ssh.HostKeyCallback {
	addr := fmt.Sprintf("%s:%d", host, port)
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		s.hostsMu.Lock()
		defer s.hostsMu.Unlock()

		known, err := s.loadKnownHosts()
		if err != nil {
			// A corrupt/unreadable file should not silently disable
			// verification: fail closed.
			return fmt.Errorf("could not read known hosts: %w", err)
		}

		marshaled := base64.StdEncoding.EncodeToString(key.Marshal())
		entry := fmt.Sprintf("%s %s %s", addr, key.Type(), marshaled)

		if recorded, ok := known[addr]; ok {
			if recorded == entry {
				return nil // key matches the pinned value
			}
			// Key mismatch -> potential man-in-the-middle. Refuse to connect.
			return fmt.Errorf("SECURITY: host key for %s has changed; possible man-in-the-middle attack. "+
				"If this is intentional (e.g. server reinstall), remove the old entry from %s",
				addr, s.knownHostsPath)
		}

		// First time seeing this host: trust and persist (TOFU).
		known[addr] = entry
		if err := s.saveKnownHosts(known); err != nil {
			// Fail-closed: if we cannot persist the key, the next connection
			// would re-enter this branch and treat the host as "first time"
			// again, effectively disabling TOFU. That would allow a MITM to
			// intercept future connections without detection. Refuse to
			// connect instead.
			return fmt.Errorf("SECURITY: failed to persist host key for %s: %w; "+
				"check write permissions for %s",
				addr, err, s.knownHostsPath)
		}
		return nil
	}
}

// loadKnownHosts parses the known_hosts file into a map keyed by "host:port".
// A missing file is treated as empty (not an error).
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

// saveKnownHosts atomically writes the known_hosts map back to disk.
func (s *SshService) saveKnownHosts(known map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(s.knownHostsPath), 0700); err != nil {
		return err
	}

	var b strings.Builder
	// stable ordering for readable diffs
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

// Input writes data to SSH stdin
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
		if active.sftpClient != nil {
			_ = active.sftpClient.Close()
		}
		if active.pipeCloser != nil {
			_ = active.pipeCloser.Close()
		}
		_ = active.session.Close()
		_ = active.client.Close()
		s.emitter.EmitClosed(sessionID)
	}
}

// GetSFTPClient 懒加载 SFTP 客户端，复用现有 SSH 连接。
// 首次调用时基于现有 *ssh.Client 创建 SFTP 子系统客户端并缓存到 session，
// 后续调用直接返回缓存的实例，避免重复建立 SFTP 通道。
// 并发安全：使用双检锁保证同一 session 只创建一次 sftpClient。
func (s *SshService) GetSFTPClient(sessionID string) (*sftp.Client, error) {
	// 快路径：若已存在缓存的客户端则直接返回
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	if exists && active.sftpClient != nil {
		client := active.sftpClient
		s.mu.RUnlock()
		return client, nil
	}
	s.mu.RUnlock()

	// 慢路径：需要创建 SFTP 客户端
	s.mu.Lock()
	defer s.mu.Unlock()
	// 重新获取 session，防止在升级锁期间被断开
	active, exists = s.sessions[sessionID]
	if !exists {
		return nil, apperror.SSHSessionNotFound()
	}
	// 双检：可能已被其它 goroutine 创建
	if active.sftpClient != nil {
		return active.sftpClient, nil
	}
	client, err := sftp.NewClient(active.client,
		sftp.MaxConcurrentRequestsPerFile(8), // 每文件 8 个并发读请求，加速大文件预览
	)
	if err != nil {
		return nil, fmt.Errorf("创建 SFTP 客户端失败: %w", err)
	}
	active.sftpClient = client
	return client, nil
}

// ResetSFTPClient 重置 SFTP 客户端缓存，下次 GetSFTPClient 时重新创建
// 用于 SFTP 连接异常后恢复
func (s *SshService) ResetSFTPClient(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if active, exists := s.sessions[sessionID]; exists && active.sftpClient != nil {
		active.sftpClient.Close()
		active.sftpClient = nil
	}
}

func (s *SshService) streamOutput(sessionID string, stdout io.Reader, current *activeSession) {
	buf := make([]byte, 32*1024)
	dataChan := make(chan []byte)

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
				}
				s.cleanupSession(sessionID, current)
				return
			}

			batch = append(batch, chunk...)

			if len(batch) >= batchSize {
				s.emitter.EmitData(sessionID, batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				s.emitter.EmitData(sessionID, batch)
				batch = batch[:0]
			}
		}
	}
}

func readOutput(stdout io.Reader, buf []byte, dataChan chan []byte) {
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

		if current.sftpClient != nil {
			_ = current.sftpClient.Close()
		}
		if current.pipeCloser != nil {
			_ = current.pipeCloser.Close()
		}
		if current.session != nil {
			_ = current.session.Close()
		}
		if current.client != nil {
			_ = current.client.Close()
		}
		s.emitter.EmitClosed(sessionID)
	} else {
		s.mu.Unlock()
	}
}
