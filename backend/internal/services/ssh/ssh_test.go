package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// newTestSshService 构造仅含转发相关字段的服务实例，避免测试触碰真实会话。
func newTestSshService() *SshService {
	return &SshService{
		forwards:        make(map[string]net.Listener),
		sessionForwards: make(map[string][]string),
	}
}

// newTestKey 生成一对 ed25519 密钥，返回公钥与 OpenSSH 格式的私钥文本。
func newTestKey(t *testing.T) (ssh.PublicKey, string) {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成测试密钥失败: %v", err)
	}

	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("构造签名者失败: %v", err)
	}

	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("序列化私钥失败: %v", err)
	}

	return signer.PublicKey(), string(pem.EncodeToMemory(block))
}

// 连接池键必须包含跳板链的每一级与代理信息，
// 否则不同链路会错误复用同一连接（串线到错误的主机）。
func TestConnKey(t *testing.T) {
	cases := []struct {
		name string
		cfg  *SSHConnectionConfig
		want string
	}{
		{
			name: "直连",
			cfg:  &SSHConnectionConfig{Host: "10.0.0.1", Port: 22, Username: "root"},
			want: "10.0.0.1:22:root",
		},
		{
			name: "单级跳板",
			cfg: &SSHConnectionConfig{
				Host: "10.0.0.1", Port: 22, Username: "root",
				JumpHost: &JumpHostConfig{Host: "jump1", Port: 22, Username: "ops"},
			},
			want: "10.0.0.1:22:root->jump1:22:ops",
		},
		{
			name: "多级跳板链",
			cfg: &SSHConnectionConfig{
				Host: "target", Port: 22, Username: "u",
				JumpHost: &JumpHostConfig{
					Host: "jump1", Port: 22, Username: "a",
					JumpHost: &JumpHostConfig{Host: "jump2", Port: 2222, Username: "b"},
				},
			},
			want: "target:22:u->jump1:22:a->jump2:2222:b",
		},
		{
			name: "经代理",
			cfg: &SSHConnectionConfig{
				Host: "h", Port: 22, Username: "u",
				ProxyType: "socks5", ProxyHost: "127.0.0.1", ProxyPort: 1080,
			},
			want: "h:22:u@proxy:socks5:127.0.0.1:1080",
		},
	}

	for _, c := range cases {
		if got := connKey(c.cfg); got != c.want {
			t.Errorf("%s: connKey() = %q, want %q", c.name, got, c.want)
		}
	}
}

// 不同跳板链必须得到不同的池键，否则会复用错误链路的连接。
func TestConnKeyDistinguishesJumpChains(t *testing.T) {
	base := &SSHConnectionConfig{Host: "t", Port: 22, Username: "u"}
	withJumpA := &SSHConnectionConfig{
		Host: "t", Port: 22, Username: "u",
		JumpHost: &JumpHostConfig{Host: "jump-a", Port: 22, Username: "u"},
	}
	withJumpB := &SSHConnectionConfig{
		Host: "t", Port: 22, Username: "u",
		JumpHost: &JumpHostConfig{Host: "jump-b", Port: 22, Username: "u"},
	}

	keys := map[string]bool{
		connKey(base):      true,
		connKey(withJumpA): true,
		connKey(withJumpB): true,
	}
	if len(keys) != 3 {
		t.Errorf("直连与不同跳板链应生成互不相同的池键，实际只有 %d 个", len(keys))
	}
}

func TestDefaultKnownHostsPath(t *testing.T) {
	got := defaultKnownHostsPath()
	if got == "" {
		t.Fatal("默认 known_hosts 路径不应为空")
	}
	if filepath.Base(got) != "known_hosts" {
		t.Errorf("默认路径应以 known_hosts 结尾，实际 %q", got)
	}
}

// known_hosts 为空文件或不存在时都应视为「尚无记录」，不报错。
func TestLoadKnownHostsMissingFile(t *testing.T) {
	svc := &SshService{knownHostsPath: filepath.Join(t.TempDir(), "known_hosts")}

	known, err := svc.loadKnownHosts()
	if err != nil {
		t.Fatalf("文件不存在时不应报错: %v", err)
	}
	if len(known) != 0 {
		t.Errorf("文件不存在时应返回空记录，实际 %d 条", len(known))
	}
}

// 注释、空行与格式不合法的行必须被跳过，不能污染记录。
func TestLoadKnownHostsSkipsInvalidLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	content := "# 注释行\n\n   \nhost-a:22 ssh-ed25519 AAAA\n缺少字段的行\nhost-b:22 ssh-rsa BBBB 附加字段\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	svc := &SshService{knownHostsPath: path}
	known, err := svc.loadKnownHosts()
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}

	if len(known) != 2 {
		t.Fatalf("应解析出 2 条记录，实际 %d 条: %v", len(known), known)
	}
	if _, ok := known["host-a:22"]; !ok {
		t.Error("缺少 host-a:22 记录")
	}
	if _, ok := known["host-b:22"]; !ok {
		t.Error("缺少 host-b:22 记录")
	}
}

// 保存后重新读取必须得到完全一致的记录（含原子写入路径）。
func TestKnownHostsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	svc := &SshService{knownHostsPath: path}

	known := map[string]string{
		"b.example:22": "b.example:22 ssh-ed25519 BBBB",
		"a.example:22": "a.example:22 ssh-ed25519 AAAA",
	}
	if err := svc.saveKnownHosts(known); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, err := svc.loadKnownHosts()
	if err != nil {
		t.Fatalf("重新读取失败: %v", err)
	}
	if len(got) != len(known) {
		t.Fatalf("记录数不一致: got %d, want %d", len(got), len(known))
	}
	for addr, entry := range known {
		if got[addr] != entry {
			t.Errorf("%s: got %q, want %q", addr, got[addr], entry)
		}
	}

	// 临时文件不应残留
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("原子写入后不应残留 .tmp 文件")
	}
}

// TOFU：首次连接记录并放行，同一密钥再次放行，密钥变化必须拒绝。
func TestHostKeyCallbackTOFU(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	svc := &SshService{knownHostsPath: path}
	cb := svc.makeHostKeyCallback("example.com", 22)

	pub1, _ := newTestKey(t)
	remote := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}

	if err := cb("example.com:22", remote, pub1); err != nil {
		t.Fatalf("首次连接应被接受: %v", err)
	}

	known, err := svc.loadKnownHosts()
	if err != nil {
		t.Fatalf("读取 known_hosts 失败: %v", err)
	}
	if _, ok := known["example.com:22"]; !ok {
		t.Fatal("首次连接后应把主机密钥写入 known_hosts")
	}

	if err := cb("example.com:22", remote, pub1); err != nil {
		t.Fatalf("相同主机密钥应被接受: %v", err)
	}

	pub2, _ := newTestKey(t)
	err = cb("example.com:22", remote, pub2)
	if err == nil {
		t.Fatal("主机密钥变化时必须拒绝连接")
	}
	if !strings.Contains(err.Error(), "has changed") {
		t.Errorf("错误信息应说明主机密钥已变化，实际 %q", err.Error())
	}
}

// 无法持久化主机密钥时必须拒绝连接（fail-closed），
// 否则每次连接都退化为「不校验」，失去防中间人能力。
func TestHostKeyCallbackFailsClosedWhenPersistFails(t *testing.T) {
	// 用普通文件充当父目录，使 MkdirAll 必然失败
	parent := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(parent, []byte("x"), 0600); err != nil {
		t.Fatalf("准备测试文件失败: %v", err)
	}

	svc := &SshService{knownHostsPath: filepath.Join(parent, "known_hosts")}
	cb := svc.makeHostKeyCallback("example.com", 22)

	pub, _ := newTestKey(t)
	err := cb("example.com:22", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}, pub)
	if err == nil {
		t.Fatal("无法写入 known_hosts 时必须拒绝连接")
	}
	if !strings.Contains(err.Error(), "failed to persist host key") {
		t.Errorf("错误信息应说明持久化失败，实际 %q", err.Error())
	}
}

// 认证方式组装：密钥与口令可同时作为候选，非法密钥不阻断口令认证。
func TestBuildAuthMethods(t *testing.T) {
	_, validKeyPEM := newTestKey(t)

	if got := buildAuthMethods("", ""); len(got) != 0 {
		t.Errorf("无密钥无口令时应返回空列表，实际 %d 项", len(got))
	}
	if got := buildAuthMethods("not-a-valid-key", "secret"); len(got) != 1 {
		t.Errorf("非法密钥应只保留口令认证，实际 %d 项", len(got))
	}
	if got := buildAuthMethods(validKeyPEM, ""); len(got) != 1 {
		t.Errorf("仅有密钥时应返回 1 项，实际 %d 项", len(got))
	}
	if got := buildAuthMethods(validKeyPEM, "secret"); len(got) != 2 {
		t.Errorf("密钥与口令应同时作为候选，实际 %d 项", len(got))
	}
}

// LocalHost 为空时必须绑定回环地址，
// 否则 net.Listen 会监听 0.0.0.0 把转发端口暴露到局域网。
func TestStartLocalForwardBindsLoopbackByDefault(t *testing.T) {
	svc := newTestSshService()
	spec := &PortForwardSpec{
		ID: "f1", SessionID: "s1", Type: "local",
		LocalHost: "   ", LocalPort: 0,
		RemoteHost: "127.0.0.1", RemotePort: 8080,
	}

	if err := svc.startLocalForward(spec, nil); err != nil {
		t.Fatalf("建立本地转发失败: %v", err)
	}

	listener, ok := svc.forwards["f1"]
	if !ok {
		t.Fatal("转发未登记到 forwards")
	}
	defer func() { _ = listener.Close() }()

	if addr := listener.Addr().String(); !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("LocalHost 为空时应绑定回环地址，实际 %s", addr)
	}
}

// 重复的转发 ID 必须报错，且不得关闭已有监听器、不得污染反向索引。
func TestStartLocalForwardDuplicateIDKeepsExisting(t *testing.T) {
	svc := newTestSshService()

	existing, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("创建已有监听器失败: %v", err)
	}
	defer func() { _ = existing.Close() }()

	svc.forwards["dup"] = existing
	svc.sessionForwards["s1"] = []string{"dup"}

	spec := &PortForwardSpec{
		ID: "dup", SessionID: "s1", Type: "local",
		LocalHost: "127.0.0.1", LocalPort: 0,
		RemoteHost: "127.0.0.1", RemotePort: 8080,
	}
	if err := svc.startLocalForward(spec, nil); err == nil {
		t.Fatal("重复的转发 ID 应返回错误")
	}

	if got, ok := svc.forwards["dup"]; !ok || got != existing {
		t.Fatal("重复 ID 不应覆盖已有转发")
	}
	if ids := svc.sessionForwards["s1"]; len(ids) != 1 || ids[0] != "dup" {
		t.Errorf("反向索引不应被污染，实际 %v", ids)
	}

	// 已有监听器必须仍然可用
	conn, err := net.Dial("tcp", existing.Addr().String())
	if err != nil {
		t.Fatalf("已有转发监听器被错误关闭: %v", err)
	}
	_ = conn.Close()
}

// 移除与批量清理转发时必须同步维护反向索引，避免会话断开后残留死条目。
func TestForwardReverseIndexMaintenance(t *testing.T) {
	svc := newTestSshService()

	l1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("创建监听器失败: %v", err)
	}
	l2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("创建监听器失败: %v", err)
	}
	defer func() { _ = l2.Close() }()

	svc.forwards["f1"] = l1
	svc.forwards["f2"] = l2
	svc.sessionForwards["s1"] = []string{"f1", "f2"}

	if err := svc.RemovePortForward("f1"); err != nil {
		t.Fatalf("移除转发失败: %v", err)
	}
	if _, ok := svc.forwards["f1"]; ok {
		t.Error("f1 应已从 forwards 移除")
	}
	if ids := svc.sessionForwards["s1"]; len(ids) != 1 || ids[0] != "f2" {
		t.Errorf("反向索引应只剩 f2，实际 %v", ids)
	}

	svc.cleanupForwards("s1")
	if len(svc.forwards) != 0 {
		t.Errorf("cleanupForwards 应清空该会话的全部转发，实际 %v", svc.forwards)
	}
	if _, ok := svc.sessionForwards["s1"]; ok {
		t.Error("cleanupForwards 应删除该会话的反向索引")
	}
}
