package charset

import "testing"

func TestParseDefaultsAndAliases(t *testing.T) {
	cases := map[string]string{
		"":             "utf-8",
		" UTF-8 ":      "utf-8",
		"utf8":         "utf-8",
		"GB2312":       "gbk",
		"gb_18030":     "gb18030",
		"Shift_JIS":    "shift-jis",
		"windows_1251": "windows-1251",
		"koi8r":        "koi8-r",
	}
	for input, want := range cases {
		spec, err := Parse(input)
		if err != nil {
			t.Fatalf("Parse(%q) 失败: %v", input, err)
		}
		if spec.Name != want {
			t.Errorf("Parse(%q).Name = %q, want %q", input, spec.Name, want)
		}
	}
}

func TestParseRejectsUnknown(t *testing.T) {
	for _, name := range []string{"ebcdic", "utf-16", "iso-2022-jp", "gbk-euc"} {
		if _, err := Parse(name); err == nil {
			t.Errorf("Parse(%q) 应被拒绝", name)
		}
	}
}

func TestEncodeUTF8IsIdentity(t *testing.T) {
	spec, err := Parse("")
	if err != nil {
		t.Fatal(err)
	}
	input := []byte("你好")
	out, err := spec.Encode(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(input) || &out[0] != &input[0] {
		t.Fatalf("UTF-8 输入不应被复制或转码: %q", out)
	}
}

func TestEncodeGBK(t *testing.T) {
	spec, err := Parse("gbk")
	if err != nil {
		t.Fatal(err)
	}
	out, err := spec.Encode([]byte("你好"))
	if err != nil {
		t.Fatal(err)
	}
	// GBK: 你 = C4 E3，好 = BA C3
	want := []byte{0xC4, 0xE3, 0xBA, 0xC3}
	if string(out) != string(want) {
		t.Fatalf("GBK 编码错误: got % X, want % X", out, want)
	}

	// ASCII 与转义序列在所有支持的编码中都应保持不变
	ascii, err := spec.Encode([]byte("\x1b[A\x03"))
	if err != nil {
		t.Fatal(err)
	}
	if string(ascii) != "\x1b[A\x03" {
		t.Fatalf("ASCII 控制序列被修改: %q", ascii)
	}
}

// 目标编码无法表示的字符应被替换，而不是让输入通道返回错误。
func TestEncodeUnsupportedRuneIsReplaced(t *testing.T) {
	spec, err := Parse("windows-1251")
	if err != nil {
		t.Fatal(err)
	}
	out, err := spec.Encode([]byte("A😀B"))
	if err != nil {
		t.Fatalf("不支持字符不应导致失败: %v", err)
	}
	if len(out) != 3 || out[0] != 'A' || out[2] != 'B' {
		t.Fatalf("替换结果异常: %q", out)
	}
}
