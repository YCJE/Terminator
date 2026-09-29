package auth

import (
	"context"
	"errors"
	"testing"

	"terminator-desktop/backend/internal/apperror"
)

// 口令长度必须按字符数校验。4 个汉字只有 4 个字符，但占 12 字节；
// 若按字节判断，这类远低于下限的口令会被错误放行。
func TestValidatePasswordLengthUsesRuneCount(t *testing.T) {
	cases := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{"五个 ASCII 字符过短", "abcde", true},
		{"四个汉字仅 4 字符但 12 字节", "密码密码", true},
		{"空口令", "", true},
		{"六个 ASCII 字符达标", "abcdef", false},
		{"六个汉字达标", "密码密码密码", false},
	}

	for _, c := range cases {
		err := validatePasswordLength(c.password)
		if c.wantErr && err == nil {
			t.Errorf("%s: 期望被拒绝，实际通过", c.name)
			continue
		}
		if !c.wantErr && err != nil {
			t.Errorf("%s: 期望通过，实际 %v", c.name, err)
		}
	}
}

// RegisterLocal 在长度校验阶段就应拒绝过短口令，不应触碰数据库。
// 这里用零值 AuthService（q 为 nil）验证：若校验顺序被改动而先访问数据库，会 panic。
func TestRegisterLocalRejectsShortPasswordBeforeDB(t *testing.T) {
	s := &AuthService{}

	err := s.RegisterLocal(context.Background(), "user", "密码密码")
	if err == nil {
		t.Fatal("期望过短口令被拒绝，实际通过")
	}

	var appErr *apperror.AppError
	if !errors.As(err, &appErr) || appErr.Code != apperror.CodeValidationFailed {
		t.Fatalf("期望 VALIDATION_FAILED，实际 %v", err)
	}
}

// 免费次数内不锁定，超过后才进入锁定期。
func TestLoginThrottleKicksInAfterFreeAttempts(t *testing.T) {
	s := &AuthService{}

	for i := 0; i < loginMaxFreeAttempts; i++ {
		s.recordLoginFailure()
	}
	if d := s.loginThrottleRemaining(); d != 0 {
		t.Fatalf("免费次数内不应锁定，实际剩余 %v", d)
	}

	s.recordLoginFailure()
	if d := s.loginThrottleRemaining(); d <= 0 {
		t.Fatal("超过免费次数后应进入锁定期")
	}
}

// 锁定期内 Login 必须直接返回 LOGIN_THROTTLED，且不访问数据库
// （零值 AuthService 的 q 为 nil，一旦访问就会 panic）。
func TestLoginBlockedWhileThrottled(t *testing.T) {
	s := &AuthService{}
	for i := 0; i < loginMaxFreeAttempts+1; i++ {
		s.recordLoginFailure()
	}

	err := s.Login(context.Background(), "anything")
	var appErr *apperror.AppError
	if !errors.As(err, &appErr) || appErr.Code != apperror.CodeLoginThrottled {
		t.Fatalf("期望 LOGIN_THROTTLED，实际 %v", err)
	}
}

// 退避时间应随失败次数指数增长，而不是固定值。
func TestLoginBackoffGrowsWithFailures(t *testing.T) {
	s := &AuthService{}
	for i := 0; i < loginMaxFreeAttempts+1; i++ {
		s.recordLoginFailure()
	}
	first := s.loginThrottleRemaining()

	s.recordLoginFailure()
	second := s.loginThrottleRemaining()

	if second <= first {
		t.Errorf("退避时间应递增，实际 %v -> %v", first, second)
	}
}

// 退避时间必须有上限，避免失败次数很多时位移溢出成负值。
func TestLoginBackoffIsCapped(t *testing.T) {
	s := &AuthService{}
	for i := 0; i < loginMaxFreeAttempts+200; i++ {
		s.recordLoginFailure()
	}

	d := s.loginThrottleRemaining()
	if d <= 0 {
		t.Fatalf("退避时间溢出为 %v，应被夹取到上限", d)
	}
	if d > loginMaxBackoff {
		t.Errorf("退避时间 %v 超过上限 %v", d, loginMaxBackoff)
	}
}

// 成功登录后应清零失败计数与锁定期。
func TestResetLoginFailuresClearsLock(t *testing.T) {
	s := &AuthService{}
	for i := 0; i < loginMaxFreeAttempts+2; i++ {
		s.recordLoginFailure()
	}
	s.resetLoginFailures()

	if d := s.loginThrottleRemaining(); d != 0 {
		t.Errorf("重置后不应再锁定，实际剩余 %v", d)
	}
}
