// Package charset 把终端会话的字符编码名称收敛为受支持的少量选项。
//
// 终端内容在协议层是字节流：SSH / Telnet / 串口本身不关心编码。
// 前端用 WHATWG 编码名解码输出，后端在发送键盘输入时把 UTF-8 转成目标编码，
// 两侧使用同一份白名单，避免用户选择了一个前端无法解码的编码。
//
// 只收录常见的中文/日文/俄文遗留编码：这些场景最需要手工指定，
// 其余编码（尤其是不兼容 ASCII 的 EBCDIC）不适合直接作为终端编码使用。
package charset

import (
	"fmt"
	"strings"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/transform"
)

// Spec 是解析后的编码。enc 为 nil 表示 UTF-8（无需转码）。
// 注意编码器是有状态的：Encode 每次新建转换器，保证并发输入（广播模式）
// 不会因共享转换状态而错位。
type Spec struct {
	Name string
	enc  encoding.Encoding
}

// supported 把规范名映射到 HTML 编码标签（htmlindex 的查询名）。
// 别名在 Parse 中先归一化为规范名，保证前端保存的值与后端一致。
var supported = map[string]string{
	"gbk":          "gbk",
	"gb18030":      "gb18030",
	"big5":         "big5",
	"shift-jis":    "shift_jis",
	"euc-jp":       "euc-jp",
	"koi8-r":       "koi8-r",
	"windows-1251": "windows-1251",
}

// aliases 收录常见写法，统一折叠到 supported 的规范名。
var aliases = map[string]string{
	"utf8":        "utf-8",
	"unicode":     "utf-8",
	"gb2312":      "gbk",
	"gb-2312":     "gbk",
	"cp936":       "gbk",
	"gb-18030":    "gb18030",
	"shiftjis":    "shift-jis",
	"sjis":        "shift-jis",
	"eucjp":       "euc-jp",
	"koi8r":       "koi8-r",
	"cp1251":      "windows-1251",
	"windows1251": "windows-1251",
}

// Parse 解析编码名称。空值与 UTF-8 都返回零值 Spec（Identity）。
func Parse(name string) (Spec, error) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	normalized = strings.ReplaceAll(normalized, "_", "-")
	if alias, ok := aliases[normalized]; ok {
		normalized = alias
	}
	switch normalized {
	case "", "utf-8":
		return Spec{Name: "utf-8"}, nil
	}
	label, ok := supported[normalized]
	if !ok {
		return Spec{}, fmt.Errorf("unsupported encoding: %s", name)
	}
	enc, err := htmlindex.Get(label)
	if err != nil {
		return Spec{}, fmt.Errorf("unsupported encoding: %s", name)
	}
	return Spec{Name: normalized, enc: enc}, nil
}

// IsUTF8 报告该编码是否无需转码。
func (s Spec) IsUTF8() bool {
	return s.enc == nil
}

// Encode 把 UTF-8 输入转为目标编码。UTF-8 原样返回，不复制切片。
// 目标编码无法表示的字符会被替换而不是报错，避免用户按下某个按键时
// 整个输入通道被一次转换失败打断。
func (s Spec) Encode(input []byte) ([]byte, error) {
	if s.enc == nil || len(input) == 0 {
		return input, nil
	}
	// 替换模式：无法表示的字符被替换，不会中断整段输入
	out, _, err := transform.Bytes(encoding.ReplaceUnsupported(s.enc.NewEncoder()), input)
	if err != nil {
		return nil, err
	}
	return out, nil
}
