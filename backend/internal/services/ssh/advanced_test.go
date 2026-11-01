package ssh

import (
	"testing"
	"time"
)

func TestTerminalTypeValidation(t *testing.T) {
	cases := map[string]string{
		"":                   defaultTermType,
		"  xterm-256color  ": "xterm-256color",
		"vt100":              "vt100",
		"screen-256color":    "screen-256color",
		"ansi":               "ansi",
		"xterm with space":   defaultTermType,
		"xterm;rm -rf /":     defaultTermType,
		"TERM\x00":           defaultTermType,
	}
	for input, want := range cases {
		got := terminalType(&SSHConnectionConfig{TermType: input})
		if got != want {
			t.Errorf("terminalType(%q) = %q, want %q", input, got, want)
		}
	}

	long := make([]byte, maxTermTypeLen+1)
	for i := range long {
		long[i] = 'a'
	}
	if got := terminalType(&SSHConnectionConfig{TermType: string(long)}); got != defaultTermType {
		t.Errorf("超长 TERM 应回退默认值，got %q", got)
	}
}

func TestConnectionTimeout(t *testing.T) {
	if got := connectionTimeout(&SSHConnectionConfig{}); got != timeout {
		t.Errorf("默认超时 = %v, want %v", got, timeout)
	}
	if got := connectionTimeout(&SSHConnectionConfig{ConnectTimeout: 5}); got != 5*time.Second {
		t.Errorf("自定义超时 = %v, want 5s", got)
	}
	if got := connectionTimeout(&SSHConnectionConfig{ConnectTimeout: -1}); got != timeout {
		t.Errorf("负值应回退默认，got %v", got)
	}
	if got := connectionTimeout(&SSHConnectionConfig{ConnectTimeout: maxConnectTimeout + 1}); got != maxConnectTimeout*time.Second {
		t.Errorf("超大值应被截断，got %v", got)
	}
}

func TestKeepAliveInterval(t *testing.T) {
	if got := keepAliveInterval(&SSHConnectionConfig{}); got != defaultKeepAlive {
		t.Errorf("默认保活 = %v, want %v", got, defaultKeepAlive)
	}
	if got := keepAliveInterval(&SSHConnectionConfig{KeepAlive: -1}); got != 0 {
		t.Errorf("负值应关闭保活，got %v", got)
	}
	if got := keepAliveInterval(&SSHConnectionConfig{KeepAlive: 10}); got != 10*time.Second {
		t.Errorf("自定义保活 = %v, want 10s", got)
	}
	if got := keepAliveInterval(&SSHConnectionConfig{KeepAlive: 1000}); got != maxKeepAlive {
		t.Errorf("超大间隔应被截断，got %v", got)
	}
}

// 编码非法时 Connect 应在建立网络连接之前就失败。
func TestConnectRejectsUnknownEncoding(t *testing.T) {
	svc := NewSshService(nil, "")
	err := svc.Connect(&SSHConnectionConfig{
		ID:       "s1",
		Host:     "127.0.0.1",
		Port:     22,
		Username: "root",
		Encoding: "ebcdic",
	})
	if err == nil {
		t.Fatal("非法编码应被拒绝")
	}
	if got := err.Error(); !contains(got, "unsupported encoding") {
		t.Errorf("错误信息未说明编码问题: %q", got)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
