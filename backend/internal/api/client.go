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
)

type Client struct {
	httpClient *http.Client
	mu         sync.RWMutex
	token      string
}

// NewClient initializes a new API client.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: 15 * time.Second, // TODO: configurable timeout?
		},
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

func (c *Client) Preflight(ctx context.Context, baseUrl string, req *PreflightRequest) (*PreflightResponse, error) {
	return do[PreflightRequest, PreflightResponse](ctx, c, http.MethodPost, baseUrl, "/auth/preflight", req)
}

func (c *Client) Login(ctx context.Context, baseUrl string, req *LoginRequest) (*AuthResponse, error) {
	return do[LoginRequest, AuthResponse](ctx, c, http.MethodPost, baseUrl, "/auth/login", req)
}

func (c *Client) Register(ctx context.Context, baseUrl string, req *RegisterRequest) (*AuthResponse, error) {
	return do[RegisterRequest, AuthResponse](ctx, c, http.MethodPost, baseUrl, "/auth/register", req)
}

func (c *Client) Sync(ctx context.Context, baseUrl string, req *SyncRequest) (*SyncResponse, error) {
	return do[SyncRequest, SyncResponse](ctx, c, http.MethodPost, baseUrl, "/sync", req)
}

func do[Req any, Res any](
	ctx context.Context,
	c *Client,
	method string,
	baseUrl string,
	path string,
	reqBody *Req,
) (*Res, error) {

	var bodyReader io.Reader = nil

	if reqBody != nil {
		jsonData, err := json.Marshal(reqBody)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(jsonData)
	}

	reqUrl, err := url.JoinPath(baseUrl, path)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, method, reqUrl, bodyReader)
	if err != nil {
		return nil, err
	}

	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if token := c.getToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, apperror.Network(err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode >= 400 {
		var errResp ErrorResponse
		err = json.NewDecoder(io.LimitReader(resp.Body, maxErrorBodySize)).Decode(&errResp)

		if err == nil && len(errResp.Errors) > 0 {
			return nil, &APIError{
				StatusCode: resp.StatusCode,
				Details:    errResp.Errors,
			}
		}

		return nil, &APIError{
			StatusCode: resp.StatusCode,
		}
	}

	var result Res
	err = json.NewDecoder(io.LimitReader(resp.Body, maxResponseBodySize)).Decode(&result)
	if err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}
