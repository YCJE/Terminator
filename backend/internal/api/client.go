package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"terminator-desktop/backend/internal/apperror"
	"time"
)

const (
	// maxErrorBodySize 限制错误响应体大小（1MB）
	maxErrorBodySize int64 = 1 << 20
	// maxResponseBodySize 限制成功响应体大小（50MB，同步响应可能含大量 blob）
	maxResponseBodySize int64 = 50 << 20

	// maxAttempts 幂等请求的最大尝试次数（含首次）
	maxAttempts = 3
	// defaultRetryBackoff 首次重试等待时间，后续按指数增长
	defaultRetryBackoff = 300 * time.Millisecond
	// maxRetryBackoff 单次重试等待上限
	maxRetryBackoff = 3 * time.Second
)

type Client struct {
	httpClient *http.Client
	mu         sync.RWMutex
	token      string
	// retryBackoff 首次重试等待时间；测试可调小以避免真实等待
	retryBackoff time.Duration
}

// NewClient initializes a new API client.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: 15 * time.Second, // TODO: configurable timeout?
		},
		retryBackoff: defaultRetryBackoff,
	}
}

func (c *Client) SetToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

func (c *Client) ClearToken() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = ""
}

// getToken safely reads the current token under a read lock.
func (c *Client) getToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

// Preflight 与 Login 为只读请求，Sync 基于 upsert 幂等，均可安全重试。
func (c *Client) Preflight(ctx context.Context, baseUrl string, req *PreflightRequest) (*PreflightResponse, error) {
	return do[PreflightRequest, PreflightResponse](ctx, c, baseUrl, "/auth/preflight", req, true)
}

func (c *Client) Login(ctx context.Context, baseUrl string, req *LoginRequest) (*AuthResponse, error) {
	return do[LoginRequest, AuthResponse](ctx, c, baseUrl, "/auth/login", req, true)
}

// Register 会创建账号，非幂等：响应丢失时重试只会得到"已存在"，
// 反而让调用方误判失败，因此不启用重试。
func (c *Client) Register(ctx context.Context, baseUrl string, req *RegisterRequest) (*AuthResponse, error) {
	return do[RegisterRequest, AuthResponse](ctx, c, baseUrl, "/auth/register", req, false)
}

func (c *Client) Sync(ctx context.Context, baseUrl string, req *SyncRequest) (*SyncResponse, error) {
	return do[SyncRequest, SyncResponse](ctx, c, baseUrl, "/sync", req, true)
}

func do[Req any, Res any](
	ctx context.Context,
	c *Client,
	baseUrl string,
	path string,
	reqBody *Req,
	allowRetry bool,
) (*Res, error) {

	var jsonData []byte
	if reqBody != nil {
		data, err := json.Marshal(reqBody)
		if err != nil {
			return nil, err
		}
		jsonData = data
	}

	reqUrl, err := url.JoinPath(baseUrl, path)
	if err != nil {
		return nil, err
	}

	attempts := 1
	if allowRetry {
		attempts = maxAttempts
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if attempt > 1 {
			// 退避期间响应取消，避免用户关闭应用后仍在等待
			select {
			case <-ctx.Done():
				return nil, apperror.Network(ctx.Err())
			case <-time.After(c.backoff(attempt - 1)):
			}
		}

		result, retryable, err := doOnce[Res](ctx, c, reqUrl, jsonData, reqBody != nil)
		if err == nil {
			return result, nil
		}
		lastErr = err

		if !retryable {
			return nil, err
		}
	}

	return nil, lastErr
}

// doOnce 执行单次请求，返回该错误是否值得重试。
func doOnce[Res any](
	ctx context.Context,
	c *Client,
	reqUrl string,
	jsonData []byte,
	hasBody bool,
) (*Res, bool, error) {

	var bodyReader io.Reader
	if hasBody {
		// 每次尝试都需要新的 Reader，否则重试时 body 已被读完
		bodyReader = bytes.NewReader(jsonData)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqUrl, bodyReader)
	if err != nil {
		return nil, false, err
	}

	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}

	if token := c.getToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// 网络层错误（连接失败、超时）通常是暂时性的
		return nil, true, apperror.Network(err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode >= 400 {
		var errResp ErrorResponse
		err = json.NewDecoder(io.LimitReader(resp.Body, maxErrorBodySize)).Decode(&errResp)

		if err == nil && len(errResp.Errors) > 0 {
			return nil, retryableStatus(resp.StatusCode), &APIError{
				StatusCode: resp.StatusCode,
				Details:    errResp.Errors,
			}
		}

		return nil, retryableStatus(resp.StatusCode), &APIError{
			StatusCode: resp.StatusCode,
		}
	}

	var result Res
	err = json.NewDecoder(io.LimitReader(resp.Body, maxResponseBodySize)).Decode(&result)
	if err != nil {
		return nil, false, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, false, nil
}

// retryableStatus 判断状态码是否属于暂时性失败：429 限流与 5xx 服务端错误可重试，
// 其余 4xx（含 401/403/400）为确定性错误，重试无意义。
func retryableStatus(code int) bool {
	return code == http.StatusTooManyRequests || code >= 500
}

// backoff 返回第 retry 次重试前的等待时间（指数退避，上限 maxRetryBackoff）。
func (c *Client) backoff(retry int) time.Duration {
	base := c.retryBackoff
	if base <= 0 {
		base = defaultRetryBackoff
	}
	d := base << (retry - 1)
	if d > maxRetryBackoff || d <= 0 {
		d = maxRetryBackoff
	}
	return d
}
