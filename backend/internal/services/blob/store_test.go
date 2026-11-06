package blob

import "testing"

// 历史客户端写入的条目没有 type 字段，必须按内容特征推断类型，
// 否则仍能解密的主机会在所有列表中消失。
func TestInferLegacyType(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want ItemType
	}{
		{
			name: "旧客户端的真实 host 载荷",
			raw:  `{"port":22,"username":"root","host":"127.0.0.1","name":"test-host","id":"1e3a4d78"}`,
			want: TypeHost,
		},
		{"密钥", `{"name":"k","privateKey":"-----BEGIN OPENSSH PRIVATE KEY-----"}`, TypeKey},
		{"片段", `{"name":"s","command":"tail -f app.log"}`, TypeSnippet},
		{"无法识别", `{"name":"unknown"}`, ""},
		{"非法 JSON", `{`, ""},
	}
	for _, tc := range cases {
		if got := inferLegacyType([]byte(tc.raw)); got != tc.want {
			t.Errorf("%s: inferLegacyType() = %q, want %q", tc.name, got, tc.want)
		}
	}
}
