package netconn

import (
	"bytes"
	"testing"

	"go.bug.st/serial"
)

func TestTelnetParserPassesPlainData(t *testing.T) {
	parser := &telnetParser{}
	plain, replies := parser.feed([]byte("hello\r\n"))
	if string(plain) != "hello\r\n" {
		t.Fatalf("普通数据被修改: %q", plain)
	}
	if len(replies) != 0 {
		t.Fatalf("普通数据不应产生应答: %v", replies)
	}
}

// 转义的 0xFF 是字面数据，必须原样交给终端。
func TestTelnetParserUnescapesIAC(t *testing.T) {
	parser := &telnetParser{}
	plain, _ := parser.feed([]byte{telnetIAC, telnetIAC})
	if len(plain) != 1 || plain[0] != telnetIAC {
		t.Fatalf("转义 IAC 解析错误: %v", plain)
	}
}

// IAC 命令可能跨读块：状态必须延续到下一段输入。
func TestTelnetParserHandlesSplitSequence(t *testing.T) {
	parser := &telnetParser{}
	if plain, _ := parser.feed([]byte{telnetIAC}); len(plain) != 0 {
		t.Fatalf("单独的 IAC 不应输出: %v", plain)
	}
	if plain, _ := parser.feed([]byte{telnetWILL}); len(plain) != 0 {
		t.Fatalf("WILL 不应输出: %v", plain)
	}
	plain, replies := parser.feed([]byte{optEcho})
	if len(plain) != 0 {
		t.Fatalf("协商字节不应输出: %v", plain)
	}
	if len(replies) != 3 || replies[0] != telnetIAC || replies[1] != telnetDO || replies[2] != optEcho {
		t.Fatalf("WILL ECHO 应答错误: %v", replies)
	}

	// 后续普通数据仍能正常输出
	plain, _ = parser.feed([]byte("ok"))
	if string(plain) != "ok" {
		t.Fatalf("协商后普通数据被丢弃: %q", plain)
	}
}

func TestTelnetParserNegotiationPolicy(t *testing.T) {
	cases := []struct {
		verb byte
		opt  byte
		want byte
	}{
		{telnetWILL, optEcho, telnetDO},
		{telnetWILL, optSGA, telnetDO},
		{telnetWILL, 34 /* LINEMODE */, telnetDONT},
		{telnetDO, optTTYPE, telnetWILL},
		{telnetDO, optNAWS, telnetWILL},
		{telnetDO, 39 /* NEW-ENVIRON */, telnetWONT},
	}
	for _, item := range cases {
		reply := negotiationReply(item.verb, item.opt)
		if len(reply) != 3 || reply[0] != telnetIAC || reply[1] != item.want || reply[2] != item.opt {
			t.Errorf("negotiationReply(%d,%d) = %v", item.verb, item.opt, reply)
		}
	}

	// 对 WONT/DONT 不应再回复
	if reply := negotiationReply(telnetWONT, optEcho); len(reply) != 0 {
		t.Errorf("WONT 不应产生回复: %v", reply)
	}
	if reply := negotiationReply(telnetDONT, optNAWS); len(reply) != 0 {
		t.Errorf("DONT 不应产生回复: %v", reply)
	}
}

// 服务端询问终端类型时应回复 XTERM-256COLOR。
func TestTelnetSubnegotiationTerminalType(t *testing.T) {
	parser := &telnetParser{}
	plain, replies := parser.feed([]byte{
		telnetIAC, telnetSB, optTTYPE, 1,
		telnetIAC, telnetSE,
	})
	if len(plain) != 0 {
		t.Fatalf("子协商不应输出到终端: %v", plain)
	}
	if !bytes.HasPrefix(replies, []byte{telnetIAC, telnetSB, optTTYPE, 0}) {
		t.Fatalf("TTYPE 应答前缀错误: %v", replies)
	}
	if !bytes.HasSuffix(replies, []byte{telnetIAC, telnetSE}) {
		t.Fatalf("TTYPE 应答缺少 SE: %v", replies)
	}
	if !bytes.Contains(replies, []byte("XTERM-256COLOR")) {
		t.Fatalf("终端类型未上报: %v", replies)
	}
}

// 子协商数据必须有上限：服务端迟迟不发 IAC SE 时不能让缓冲无限增长。
func TestTelnetSubnegotiationBufferIsBounded(t *testing.T) {
	parser := &telnetParser{}
	parser.feed([]byte{telnetIAC, telnetSB, optNAWS, 1})
	parser.feed(bytes.Repeat([]byte{0x41}, maxSuboptionBytes*2))
	if len(parser.subData) != maxSuboptionBytes {
		t.Fatalf("子协商缓冲未被限制: %d", len(parser.subData))
	}
	// 超限后仍要能正常结束子协商并恢复普通数据
	plain, _ := parser.feed([]byte{telnetIAC, telnetSE, 'o', 'k'})
	if string(plain) != "ok" {
		t.Fatalf("子协商结束后普通数据未恢复: %q", plain)
	}
}

func TestEscapeTelnetIAC(t *testing.T) {
	in := []byte{0x01, 0xFF, 0x02}
	out := escapeTelnetIAC(in)
	if len(out) != 4 || out[1] != 0xFF || out[2] != 0xFF {
		t.Fatalf("IAC 转义错误: %v", out)
	}
}

func TestNawsPayload(t *testing.T) {
	payload := nawsPayload(24, 80)
	want := []byte{telnetIAC, telnetSB, optNAWS, 0, 80, 0, 24, telnetIAC, telnetSE}
	if !bytes.Equal(payload, want) {
		t.Fatalf("NAWS 载荷错误:\n got %v\nwant %v", payload, want)
	}

	// 宽高含 255 时必须双写转义
	payload = nawsPayload(255, 255)
	want = []byte{telnetIAC, telnetSB, optNAWS, 0, 255, 255, 0, 255, 255, telnetIAC, telnetSE}
	if !bytes.Equal(payload, want) {
		t.Fatalf("255 尺寸转义错误:\n got %v\nwant %v", payload, want)
	}
}

func TestSerialModeValidation(t *testing.T) {
	mode, err := serialMode(SerialConfig{})
	if err != nil {
		t.Fatalf("默认参数应可用: %v", err)
	}
	if mode.BaudRate != 115200 || mode.DataBits != 8 || mode.Parity != serial.NoParity || mode.StopBits != serial.OneStopBit {
		t.Fatalf("默认串口模式错误: %+v", mode)
	}

	if _, err := serialMode(SerialConfig{DataBits: 4}); err == nil {
		t.Error("数据位 4 应被拒绝")
	}
	if _, err := serialMode(SerialConfig{StopBits: 3}); err == nil {
		t.Error("停止位 3 应被拒绝")
	}
	if _, err := serialMode(SerialConfig{Parity: "mark"}); err == nil {
		t.Error("不支持的校验位应被拒绝")
	}

	mode, err = serialMode(SerialConfig{BaudRate: 9600, DataBits: 7, StopBits: 2, Parity: "even"})
	if err != nil {
		t.Fatalf("合法参数被拒绝: %v", err)
	}
	if mode.BaudRate != 9600 || mode.DataBits != 7 || mode.StopBits != serial.TwoStopBits || mode.Parity != serial.EvenParity {
		t.Fatalf("串口模式错误: %+v", mode)
	}
}

func TestOpenTelnetRejectsInvalidInput(t *testing.T) {
	svc := NewService(nil)
	if err := svc.OpenTelnet("", "host", 23, ""); err == nil {
		t.Error("空会话 ID 应被拒绝")
	}
	if err := svc.OpenTelnet("s1", "  ", 23, ""); err == nil {
		t.Error("空主机地址应被拒绝")
	}
	if err := svc.OpenTelnet("s1", "host", 0, ""); err == nil {
		t.Error("端口 0 应被拒绝")
	}
	if err := svc.OpenTelnet("s1", "host", 23, "ebcdic"); err == nil {
		t.Error("不支持的编码应被拒绝")
	}
	if err := svc.OpenSerial("s1", SerialConfig{}); err == nil {
		t.Error("空串口设备应被拒绝")
	}
	if err := svc.OpenSerial("s1", SerialConfig{Device: "COM9", Encoding: "utf-16"}); err == nil {
		t.Error("不支持的串口编码应被拒绝")
	}
}

func TestServiceInputOnMissingSession(t *testing.T) {
	svc := NewService(nil)
	if err := svc.Input("missing", "x"); err == nil {
		t.Error("缺失会话的输入应返回错误")
	}
	if err := svc.Resize("missing", 24, 80); err == nil {
		t.Error("缺失会话的 Resize 应返回错误")
	}
	if err := svc.Close("missing"); err != nil {
		t.Errorf("关闭缺失会话应静默成功: %v", err)
	}
}
