package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient() *Client {
	c := NewClient()
	c.retryBackoff = time.Millisecond // 测试中不真实等待
	return c
}

func TestRetryOnServerErrorThenSuccess(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(AuthResponse{AccessToken: "tok"})
	}))
	defer srv.Close()

	res, err := newTestClient().Login(context.Background(), srv.URL, &LoginRequest{Username: "u", LoginKey: "k"})
	if err != nil {
		t.Fatalf("期望重试后成功，实际错误: %v", err)
	}
	if res.AccessToken != "tok" {
		t.Fatalf("AccessToken = %q, want tok", res.AccessToken)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("调用次数 = %d, want 3", got)
	}
}

func TestRetryExhaustsAndReturnsError(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	_, err := newTestClient().Sync(context.Background(), srv.URL, &SyncRequest{})
	if err == nil {
		t.Fatal("期望最终失败")
	}
	if got := atomic.LoadInt32(&calls); got != maxAttempts {
		t.Fatalf("调用次数 = %d, want %d", got, maxAttempts)
	}
}

func TestNoRetryOnClientError(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(ErrorResponse{
			Errors: []ErrorDetail{{Code: "unauthorized", Message: "bad key"}},
		})
	}))
	defer srv.Close()

	_, err := newTestClient().Login(context.Background(), srv.URL, &LoginRequest{Username: "u", LoginKey: "k"})
	if err == nil {
		t.Fatal("期望返回 401 错误")
	}

	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("期望 APIError 401，实际 %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("401 不应重试，调用次数 = %d, want 1", got)
	}
}

// Register 非幂等，必须只请求一次，避免响应丢失时重复创建账号
func TestRegisterDoesNotRetry(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, _ = newTestClient().Register(context.Background(), srv.URL, &RegisterRequest{Username: "u"})
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("Register 不应重试，调用次数 = %d, want 1", got)
	}
}

// 重试期间上下文取消应立即返回，而不是继续等待退避
func TestRetryStopsOnContextCancel(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	c := NewClient()
	c.retryBackoff = 50 * time.Millisecond

	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	_, err := c.Sync(ctx, srv.URL, &SyncRequest{})
	if err == nil {
		t.Fatal("期望上下文取消后返回错误")
	}
	if got := atomic.LoadInt32(&calls); got > 2 {
		t.Fatalf("取消后不应继续重试，调用次数 = %d", got)
	}
}
