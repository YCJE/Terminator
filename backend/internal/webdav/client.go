package webdav

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"time"
)

// httpTimeout WebDAV 请求的超时时间
const httpTimeout = 30 * time.Second

// maxResponseBody 响应体最大读取大小（10MB），防止恶意服务器返回超大响应导致 OOM
const maxResponseBody = 10 * 1024 * 1024

// newClient 创建一个带超时设置的 HTTP 客户端
func newClient() *http.Client {
	return &http.Client{
		Timeout: httpTimeout,
	}
}

// setBasicAuth 设置 Basic 认证头
func setBasicAuth(req *http.Request, username, password string) {
	if username != "" || password != "" {
		req.SetBasicAuth(username, password)
	}
}

// GetFile 通过 GET 请求下载文件，返回文件内容和 ETag
func GetFile(url, username, password string) (data []byte, etag string, err error) {
	client := newClient()

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, "", fmt.Errorf("创建 GET 请求失败: %w", err)
	}
	setBasicAuth(req, username, password)

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("WebDAV GET 请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 404 表示远端文件还不存在，属于正常情况，用空 etag 表示
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", nil
	}

	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("WebDAV GET 返回错误状态码: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
	if err != nil {
		return nil, "", fmt.Errorf("读取 WebDAV 响应体失败: %w", err)
	}

	etag = resp.Header.Get("ETag")
	return body, etag, nil
}

// PutFile 通过 PUT 上传文件，支持 If-Match 乐观锁。
// ifMatchETag 为空时表示新建文件（不带 If-Match 头）；
// 非空时表示更新已有文件，若服务端 ETag 不匹配会返回 412 Precondition Failed。
// 返回上传成功后的新 ETag。
func PutFile(url, username, password string, data []byte, ifMatchETag string) (newETag string, err error) {
	client := newClient()

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("创建 PUT 请求失败: %w", err)
	}
	setBasicAuth(req, username, password)

	req.Header.Set("Content-Type", "application/octet-stream")
	if ifMatchETag != "" {
		req.Header.Set("If-Match", ifMatchETag)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("WebDAV PUT 请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// 读取并丢弃响应体，确保连接可复用
	_, _ = io.Copy(io.Discard, resp.Body)

	// 412 表示 ETag 不匹配，发生了冲突
	if resp.StatusCode == http.StatusPreconditionFailed {
		return "", &PreconditionFailedError{URL: url}
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("WebDAV PUT 返回错误状态码: %d", resp.StatusCode)
	}

	newETag = resp.Header.Get("ETag")
	return newETag, nil
}

// DeleteFile 通过 DELETE 删除远端文件
func DeleteFile(url, username, password string) error {
	client := newClient()

	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return fmt.Errorf("创建 DELETE 请求失败: %w", err)
	}
	setBasicAuth(req, username, password)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("WebDAV DELETE 请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	// 404 视为删除成功（文件本来就不存在）
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}

	if resp.StatusCode >= 400 {
		return fmt.Errorf("WebDAV DELETE 返回错误状态码: %d", resp.StatusCode)
	}

	return nil
}

// TestConnection 通过 PROPFIND 请求测试 WebDAV 连接是否可用
func TestConnection(url, username, password string) error {
	client := newClient()

	// 最小的 PROPFIND 请求体，仅请求 resourcetype 属性
	propfindBody := `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`

	req, err := http.NewRequest("PROPFIND", url, bytes.NewReader([]byte(propfindBody)))
	if err != nil {
		return fmt.Errorf("创建 PROPFIND 请求失败: %w", err)
	}
	setBasicAuth(req, username, password)

	req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	req.Header.Set("Depth", "0")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("WebDAV PROPFIND 请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("WebDAV 连接测试失败，状态码: %d", resp.StatusCode)
	}

	// 207 Multi-Status 是 PROPFIND 的标准成功响应
	if resp.StatusCode == http.StatusMultiStatus {
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
		if err != nil {
			return fmt.Errorf("读取 PROPFIND 响应体失败: %w", err)
		}
		// 解析 PROPFIND 响应以验证返回的是合法的 WebDAV multistatus
		var ms multistatus
		if err := xml.Unmarshal(body, &ms); err != nil {
			return fmt.Errorf("解析 PROPFIND 响应失败: %w", err)
		}
		return nil
	}

	// 部分 WebDAV 服务器可能返回 200，也视为连接成功
	return nil
}

// PreconditionFailedError 表示 PUT 时 If-Match 条件不满足（远端已被其他端修改）
type PreconditionFailedError struct {
	URL string
}

func (e *PreconditionFailedError) Error() string {
	return fmt.Sprintf("WebDAV 预条件失败（远端文件已变更）: %s", e.URL)
}

// --- PROPFIND 响应解析相关结构体 ---

// multistatus 对应 WebDAV PROPFIND 的多状态响应根节点
type multistatus struct {
	XMLName   xml.Name        `xml:"multistatus"`
	Responses []propResponse  `xml:"response"`
}

// propResponse 对应单个资源的响应
type propResponse struct {
	Href     string     `xml:"href"`
	Propstat []propstat `xml:"propstat"`
}

// propstat 包含属性和状态
type propstat struct {
	Prop   prop   `xml:"prop"`
	Status string `xml:"status"`
}

// prop 包含请求的属性，这里只关心 resourcetype
type prop struct {
	ResourceType resourceType `xml:"resourcetype"`
}

// resourceType 标识资源类型（集合/文件）
type resourceType struct {
	Collection *xml.Name `xml:"collection"`
}
