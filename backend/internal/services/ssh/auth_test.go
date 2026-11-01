package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// buildUserCertificate 用临时 CA 签发一张用户证书，返回 authorized_keys 文本。
func buildUserCertificate(t *testing.T, key ssh.PublicKey) string {
	t.Helper()
	_, caPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成 CA 密钥失败: %v", err)
	}
	caSigner, err := ssh.NewSignerFromKey(caPriv)
	if err != nil {
		t.Fatalf("构造 CA 签名者失败: %v", err)
	}
	cert := &ssh.Certificate{
		Key:             key,
		CertType:        ssh.UserCert,
		KeyId:           "terminator-test",
		ValidPrincipals: []string{"tester"},
		ValidAfter:      uint64(time.Now().Add(-time.Minute).Unix()),
		ValidBefore:     uint64(time.Now().Add(time.Hour).Unix()),
	}
	if err := cert.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatalf("签发证书失败: %v", err)
	}
	return string(ssh.MarshalAuthorizedKey(cert))
}

func TestBuildAuthMethodsWithCertificate(t *testing.T) {
	pub, keyPEM := newTestKey(t)
	certificate := buildUserCertificate(t, pub)

	// 证书 + 私钥：证书签名者在前，原始私钥作为后备
	methods, err := buildAuthMethods(keyPEM, "", "", certificate)
	if err != nil {
		t.Fatalf("证书认证组装失败: %v", err)
	}
	if len(methods) != 2 {
		t.Errorf("应返回证书与私钥 2 项，实际 %d", len(methods))
	}

	// 证书与私钥不配对：必须在连接前失败，而不是发出一次注定被拒的认证
	_, otherKeyPEM := newTestKey(t)
	if _, err := buildAuthMethods(otherKeyPEM, "", "", certificate); err == nil {
		t.Error("证书与私钥不匹配时应返回错误")
	}

	// 证书缺少私钥
	if _, err := buildAuthMethods("", "", "", certificate); err == nil {
		t.Error("仅提供证书时应返回错误")
	}

	// 内容不是证书（普通公钥）
	if _, err := buildAuthMethods(keyPEM, "", "", string(ssh.MarshalAuthorizedKey(pub))); err == nil {
		t.Error("普通公钥不应被当作证书")
	}

	// 显式证书 + 无法解析的私钥：直接报错而不是静默降级
	if _, err := buildAuthMethods("not-a-key", "", "", certificate); err == nil {
		t.Error("证书与不可解析私钥同时存在时应报错")
	}
}

// fakeAuthPrompter 记录推送的问答请求。
type fakeAuthPrompter struct {
	requests chan AuthPromptRequest
}

func (f *fakeAuthPrompter) EmitAuthPrompt(request AuthPromptRequest) {
	f.requests <- request
}

func newAuthTestService(prompter AuthPrompter) *SshService {
	svc := NewSshService(nil, "")
	svc.SetAuthPrompter(prompter)
	return svc
}

type kiResult struct {
	answers []string
	err     error
}

// 单一密码问题应静默复用已保存密码，不打扰用户。
func TestKeyboardInteractiveUsesStoredPassword(t *testing.T) {
	svc := newAuthTestService(nil)
	challenge := svc.keyboardInteractiveChallenge(&SSHConnectionConfig{
		ID: "s1", Host: "example.com", Username: "root", Password: "secret",
	})

	answers, err := challenge("root", "", []string{"Password:"}, []bool{false})
	if err != nil {
		t.Fatalf("静默回答失败: %v", err)
	}
	if len(answers) != 1 || answers[0] != "secret" {
		t.Fatalf("回答 = %v，期望使用保存的密码", answers)
	}
}

// 多问题（密码 + OTP）应推送到前端，用户回答后原样回传。
func TestKeyboardInteractivePromptsAndSubmits(t *testing.T) {
	prompter := &fakeAuthPrompter{requests: make(chan AuthPromptRequest, 1)}
	svc := newAuthTestService(prompter)
	config := &SSHConnectionConfig{ID: "s1", Host: "example.com", Username: "root", Password: "secret"}
	challenge := svc.keyboardInteractiveChallenge(config)

	resultCh := make(chan kiResult, 1)
	go func() {
		answers, err := challenge("root", "Enter MFA code", []string{"Password:", "Verification code:"}, []bool{false, false})
		resultCh <- kiResult{answers: answers, err: err}
	}()

	var request AuthPromptRequest
	select {
	case request = <-prompter.requests:
	case <-time.After(2 * time.Second):
		t.Fatal("未收到交互式认证请求")
	}
	if request.SessionID != "s1" || request.Username != "root" || request.Host != "example.com" {
		t.Fatalf("请求上下文错误: %+v", request)
	}
	if request.Instruction != "Enter MFA code" {
		t.Errorf("提示语 = %q", request.Instruction)
	}
	if len(request.Prompts) != 2 || request.Prompts[1].Echo {
		t.Fatalf("问题列表错误: %+v", request.Prompts)
	}

	if err := svc.SubmitAuthResponses(request.RequestID, []string{"secret", "123456"}); err != nil {
		t.Fatalf("提交回答失败: %v", err)
	}

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("认证回调返回错误: %v", result.err)
		}
		if len(result.answers) != 2 || result.answers[1] != "123456" {
			t.Fatalf("回答未按顺序回传: %v", result.answers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("认证回调未返回")
	}

	// 同一请求只允许应答一次
	if err := svc.SubmitAuthResponses(request.RequestID, []string{"again"}); err == nil {
		t.Error("重复提交应返回请求已失效")
	}
}

func TestKeyboardInteractiveCancel(t *testing.T) {
	prompter := &fakeAuthPrompter{requests: make(chan AuthPromptRequest, 1)}
	svc := newAuthTestService(prompter)
	challenge := svc.keyboardInteractiveChallenge(&SSHConnectionConfig{ID: "s1", Host: "h", Username: "u"})

	resultCh := make(chan kiResult, 1)
	go func() {
		answers, err := challenge("u", "", []string{"Verification code:"}, []bool{false})
		resultCh <- kiResult{answers: answers, err: err}
	}()

	request := <-prompter.requests
	if err := svc.CancelAuthPrompt(request.RequestID); err != nil {
		t.Fatalf("取消失败: %v", err)
	}

	select {
	case result := <-resultCh:
		if result.err == nil || !strings.Contains(result.err.Error(), "取消") {
			t.Fatalf("取消后应返回取消错误，实际 %v", result.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消后认证回调未返回")
	}
}

func TestKeyboardInteractiveTimeout(t *testing.T) {
	original := authPromptTimeout
	authPromptTimeout = 80 * time.Millisecond
	defer func() { authPromptTimeout = original }()

	prompter := &fakeAuthPrompter{requests: make(chan AuthPromptRequest, 1)}
	svc := newAuthTestService(prompter)
	challenge := svc.keyboardInteractiveChallenge(&SSHConnectionConfig{ID: "s1"})

	// 前端一直不回答：回调应在超时后失败，而不是永久挂起
	answers, err := challenge("u", "", []string{"Verification code:"}, []bool{false})
	if err == nil {
		t.Fatalf("超时后应返回错误，实际回答 %v", answers)
	}
	if !strings.Contains(err.Error(), "超时") {
		t.Errorf("错误信息应说明超时，实际 %q", err.Error())
	}
}

func TestKeyboardInteractiveWithoutPrompter(t *testing.T) {
	svc := newAuthTestService(nil)
	challenge := svc.keyboardInteractiveChallenge(&SSHConnectionConfig{ID: "s1", Password: "secret"})

	// 非密码类问题在无 UI 通道时必须明确报错，避免用密码乱答
	if _, err := challenge("u", "", []string{"Verification code:"}, []bool{false}); err == nil {
		t.Error("无 UI 通道时非密码问题应返回错误")
	}

	// 全部是密码问题时可用密码自动回答
	answers, err := challenge("u", "", []string{"Password:", "Repeat password:"}, []bool{false, false})
	if err != nil {
		t.Fatalf("密码问题自动回答失败: %v", err)
	}
	if len(answers) != 2 || answers[0] != "secret" || answers[1] != "secret" {
		t.Fatalf("自动回答错误: %v", answers)
	}
}

// 提示语截断后仍是合法 UTF-8，不会切坏中文。
func TestTruncatePromptTextKeepsUTF8(t *testing.T) {
	text := strings.Repeat("验证码", 100)
	got := truncatePromptText(text, 7)
	if !strings.HasPrefix(text, got) {
		t.Fatalf("截断结果不是原文本前缀: %q", got)
	}
	for _, r := range got {
		if r == '\uFFFD' {
			t.Fatalf("截断产生了非法字符: %q", got)
		}
	}
	if len(got) >= 7 {
		t.Fatalf("截断长度 %d 应小于 7", len(got))
	}
}
