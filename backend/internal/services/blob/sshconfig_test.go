package blob

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSSHConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("写入测试配置失败: %v", err)
	}
	return path
}

func TestParseSSHConfigFile(t *testing.T) {
	path := writeSSHConfig(t, `
# 全局注释
Host prod
    HostName 10.0.0.1
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_prod

Host db
    HostName=10.0.0.2
    User=root

Host *.example.com
    User ignored

Match host foo
    User ignored

Host wildcarded
    HostName 10.0.0.3
    ProxyJump prod
`)

	entries, err := parseSSHConfigFile(path)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("期望 3 条主机，实际 %d: %+v", len(entries), entries)
	}

	prod := entries[0]
	if prod.Alias != "prod" || prod.Host != "10.0.0.1" || prod.Port != 2222 || prod.Username != "deploy" {
		t.Errorf("prod 解析不正确: %+v", prod)
	}
	if prod.IdentityFile == "" || prod.IdentityFile[0] == '~' {
		t.Errorf("IdentityFile 未展开 ~: %+v", prod.IdentityFile)
	}

	db := entries[1]
	if db.Host != "10.0.0.2" || db.Port != 22 || db.Username != "root" {
		t.Errorf("db 解析不正确（含等号写法与默认端口）: %+v", db)
	}

	wild := entries[2]
	if wild.Host != "10.0.0.3" || wild.ProxyJump != "prod" {
		t.Errorf("wildcarded 解析不正确: %+v", wild)
	}
}

func TestParseSSHConfigFileMissing(t *testing.T) {
	_, err := parseSSHConfigFile(filepath.Join(t.TempDir(), "nope"))
	if err == nil {
		t.Fatal("配置文件不存在时应返回错误")
	}
}

func TestParseSSHConfigFileDedupAlias(t *testing.T) {
	path := writeSSHConfig(t, `
Host dup
    HostName 1.1.1.1
Host dup
    HostName 2.2.2.2
`)
	entries, err := parseSSHConfigFile(path)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(entries) != 1 || entries[0].Host != "1.1.1.1" {
		t.Fatalf("重复别名应按首次出现去重，实际: %+v", entries)
	}
}
