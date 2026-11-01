// Package netconn 提供 Telnet 与串口会话的原始终端连接。
//
// 与 SSH 服务共用同一套数据事件（ssh:data / ssh:closed），前端终端组件
// 只需按会话 kind 路由输入、尺寸与关闭操作，显示逻辑完全复用。
//
// Telnet 侧实现 RFC 854/857/858/1073/1091 的最小可用子集：
// 选项协商（ECHO/SGA/BINARY/TTYPE/NAWS）、终端类型上报与窗口尺寸通知，
// 并把 IAC 协议序列从输出流中剥离，只把普通数据交给终端。
package netconn

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/services/charset"

	"go.bug.st/serial"
)

// Emitter 与 SSH 服务共用的事件接口。
type Emitter interface {
	EmitData(sessionID string, data []byte)
	EmitClosed(sessionID string)
}

const dialTimeout = 15 * time.Second

// Telnet 协议字节与选项号。
const (
	telnetIAC  = 255
	telnetDONT = 254
	telnetDO   = 253
	telnetWONT = 252
	telnetWILL = 251
	telnetSB   = 250
	telnetSE   = 240

	optBinary = 0
	optEcho   = 1
	optSGA    = 3
	optTTYPE  = 24
	optNAWS   = 31

	// maxSuboptionBytes 限制单个子协商的数据量。
	// 子协商只有 TTYPE/NAWS 这类几个字节的内容；异常设备或恶意服务端
	// 发来 IAC SB 后一直不发 IAC SE 时，若不设上限，缓冲会随输出无限增长。
	// 超限后继续消费字节直到 SE，只是不再保存，状态机不会卡住。
	maxSuboptionBytes = 1024
)

// conn 是一个 Telnet 或串口会话。
type conn struct {
	kind      string
	sessionID string
	telnet    net.Conn
	serial    serial.Port
	emitter   Emitter
	encoding  charset.Spec
	writeMu   sync.Mutex
	closeOnce sync.Once
}

// write 串行化写入：窗口尺寸协商与用户输入可能并发写同一条连接。
func (c *conn) write(data []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.telnet != nil {
		return c.telnet.Write(data)
	}
	if c.serial != nil {
		return c.serial.Write(data)
	}
	return 0, errors.New("connection closed")
}

func (c *conn) close() {
	c.closeOnce.Do(func() {
		if c.telnet != nil {
			_ = c.telnet.Close()
		}
		if c.serial != nil {
			_ = c.serial.Close()
		}
	})
}

// Service 管理 Telnet 与串口连接。
type Service struct {
	emitter  Emitter
	mu       sync.RWMutex
	sessions map[string]*conn
}

func NewService(emitter Emitter) *Service {
	return &Service{
		emitter:  emitter,
		sessions: make(map[string]*conn),
	}
}

// OpenTelnet 建立 Telnet 会话。端口通常为 23，部分设备使用 2323 等。
// encoding 为目标字符编码，空值/utf-8 表示 UTF-8。
func (s *Service) OpenTelnet(sessionID string, host string, port int, encoding string) error {
	if strings.TrimSpace(sessionID) == "" {
		return apperror.Validation("session id is required")
	}
	cleanHost := strings.TrimSpace(host)
	if cleanHost == "" {
		return apperror.Validation("主机地址不能为空")
	}
	if port <= 0 || port > 65535 {
		return apperror.Validation("Telnet 端口必须在 1-65535 之间")
	}
	spec, err := charset.Parse(encoding)
	if err != nil {
		return apperror.Validation(err.Error())
	}

	addr := net.JoinHostPort(cleanHost, strconv.Itoa(port))
	raw, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to %s", addr), err)
	}

	c := &conn{kind: "telnet", sessionID: sessionID, telnet: raw, emitter: s.emitter, encoding: spec}
	s.register(sessionID, c)

	// 初始协商：声明终端类型与窗口尺寸能力，并要求对端回声/关闭流控。
	// 失败不阻断连接，多数服务端会在首次 WILL/DO 时再次询问。
	_, _ = c.write(initialTelnetNegotiation())

	go s.readTelnet(c)
	return nil
}

// SerialConfig 串口参数（由前端会话对话框传入）。
type SerialConfig struct {
	Device   string `json:"device"`
	BaudRate int    `json:"baudRate"`
	DataBits int    `json:"dataBits"`
	StopBits int    `json:"stopBits"`
	Parity   string `json:"parity"`
	// Encoding 是设备字符编码；空值/utf-8 表示 UTF-8。
	Encoding string `json:"encoding,omitempty"`
}

// ListSerialPorts 返回本机可用串口（Windows 上形如 COM3）。
func (s *Service) ListSerialPorts() []string {
	ports, err := serial.GetPortsList()
	if err != nil {
		slog.Warn("failed to list serial ports", "error", err)
		return []string{}
	}
	return ports
}

// OpenSerial 打开串口会话。
func (s *Service) OpenSerial(sessionID string, config SerialConfig) error {
	if strings.TrimSpace(sessionID) == "" {
		return apperror.Validation("session id is required")
	}
	device := strings.TrimSpace(config.Device)
	if device == "" {
		return apperror.Validation("串口设备不能为空")
	}
	mode, err := serialMode(config)
	if err != nil {
		return err
	}
	spec, err := charset.Parse(config.Encoding)
	if err != nil {
		return apperror.Validation(err.Error())
	}

	port, err := serial.Open(device, mode)
	if err != nil {
		return fmt.Errorf("打开串口 %s 失败: %w", device, err)
	}

	c := &conn{kind: "serial", sessionID: sessionID, serial: port, emitter: s.emitter, encoding: spec}
	s.register(sessionID, c)
	go s.readSerial(c)
	return nil
}

// serialMode 把前端参数收敛为串口模式，拒绝超出常见范围的取值。
func serialMode(config SerialConfig) (*serial.Mode, error) {
	baud := config.BaudRate
	if baud <= 0 {
		baud = 115200
	}
	if baud > 4_000_000 {
		return nil, apperror.Validation("波特率过高")
	}
	dataBits := config.DataBits
	if dataBits == 0 {
		dataBits = 8
	}
	if dataBits < 5 || dataBits > 8 {
		return nil, apperror.Validation("数据位必须在 5-8 之间")
	}
	stopBits := serial.OneStopBit
	switch config.StopBits {
	case 0, 1:
		stopBits = serial.OneStopBit
	case 2:
		stopBits = serial.TwoStopBits
	default:
		return nil, apperror.Validation("停止位只能是 1 或 2")
	}
	parity := serial.NoParity
	switch strings.ToLower(strings.TrimSpace(config.Parity)) {
	case "", "none":
		parity = serial.NoParity
	case "odd":
		parity = serial.OddParity
	case "even":
		parity = serial.EvenParity
	default:
		return nil, apperror.Validation("校验位只支持 none/odd/even")
	}
	return &serial.Mode{
		BaudRate: baud,
		DataBits: dataBits,
		Parity:   parity,
		StopBits: stopBits,
	}, nil
}

func (s *Service) register(sessionID string, c *conn) {
	// 同一会话 ID 重复打开时先关闭旧连接，避免两个读循环同时写事件
	s.mu.Lock()
	previous := s.sessions[sessionID]
	s.sessions[sessionID] = c
	s.mu.Unlock()
	if previous != nil {
		previous.close()
	}
}

// remove 从会话表移除连接，返回它是否仍是当前连接。
// 重连时旧连接的读循环可能晚于新连接退出：此时不能发出 closed 事件，
// 否则前端会把刚刚建立的新会话误标为断开。
func (s *Service) remove(sessionID string, c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.sessions[sessionID]; ok && current == c {
		delete(s.sessions, sessionID)
		return true
	}
	return false
}

// Input 写入终端输入。Telnet 会先对 IAC 字节做转义（RFC 854）。
func (s *Service) Input(sessionID string, data string) error {
	c := s.get(sessionID)
	if c == nil {
		return apperror.SSHSessionNotFound()
	}
	// 键盘输入是 UTF-8；转换失败时直接返回，避免半截多字节字符写进设备
	payload, err := c.encoding.Encode([]byte(data))
	if err != nil {
		return apperror.Validation("failed to encode terminal input")
	}
	if c.telnet != nil {
		payload = escapeTelnetIAC(payload)
	}
	_, err = c.write(payload)
	return err
}

// InputBase64 写入原始字节（ZMODEM 等二进制协议）。
// Telnet 仍需转义 IAC，否则内容中的 0xFF 会被对端当作命令。
func (s *Service) InputBase64(sessionID string, dataBase64 string) error {
	c := s.get(sessionID)
	if c == nil {
		return apperror.SSHSessionNotFound()
	}
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return apperror.Validation("invalid base64 payload")
	}
	if c.telnet != nil {
		raw = escapeTelnetIAC(raw)
	}
	_, err = c.write(raw)
	return err
}

// Resize 通知 Telnet 服务端新的窗口尺寸（NAWS）。串口无尺寸概念，直接忽略。
func (s *Service) Resize(sessionID string, rows, cols int) error {
	c := s.get(sessionID)
	if c == nil {
		return apperror.SSHSessionNotFound()
	}
	if c.telnet == nil {
		return nil
	}
	if rows <= 0 || cols <= 0 || rows > 65535 || cols > 65535 {
		return apperror.Validation("终端尺寸无效")
	}
	_, err := c.write(nawsPayload(rows, cols))
	return err
}

// Close 关闭指定会话。
func (s *Service) Close(sessionID string) error {
	s.mu.Lock()
	c := s.sessions[sessionID]
	if c != nil {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()
	if c == nil {
		return nil
	}
	c.close()
	return nil
}

// CloseAll 关闭全部会话（锁定/退出时调用）。
func (s *Service) CloseAll() {
	s.mu.Lock()
	list := make([]*conn, 0, len(s.sessions))
	for _, c := range s.sessions {
		list = append(list, c)
	}
	s.sessions = make(map[string]*conn)
	s.mu.Unlock()
	for _, c := range list {
		c.close()
	}
}

// DisconnectAll 与 SSH 服务的断开接口保持一致，供擦除数据/导入数据流程统一调用。
func (s *Service) DisconnectAll() {
	s.CloseAll()
}

func (s *Service) get(sessionID string) *conn {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[sessionID]
}

// isCurrent 报告 c 是否仍是该会话的当前连接。
// 重连时旧连接被 register 关闭，但它的读循环可能已经取到一块数据、尚未发事件；
// 这块数据属于上一条连接，必须丢弃，否则会混进新终端里。
func (s *Service) isCurrent(c *conn) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[c.sessionID] == c
}

func (s *Service) readTelnet(c *conn) {
	defer func() {
		c.close()
		if s.remove(c.sessionID, c) {
			s.emitter.EmitClosed(c.sessionID)
		}
	}()

	parser := &telnetParser{}
	buffer := make([]byte, 8192)
	for {
		n, err := c.telnet.Read(buffer)
		if n > 0 {
			plain, replies := parser.feed(buffer[:n])
			if len(replies) > 0 {
				_, _ = c.write(replies)
			}
			// 仅当前连接才允许把数据写给前端：重连后旧连接的在途数据必须丢弃
			if len(plain) > 0 && s.isCurrent(c) {
				s.emitter.EmitData(c.sessionID, plain)
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Service) readSerial(c *conn) {
	defer func() {
		c.close()
		if s.remove(c.sessionID, c) {
			s.emitter.EmitClosed(c.sessionID)
		}
	}()

	buffer := make([]byte, 4096)
	for {
		n, err := c.serial.Read(buffer)
		if n > 0 && s.isCurrent(c) {
			s.emitter.EmitData(c.sessionID, buffer[:n])
		}
		if err != nil {
			return
		}
	}
}

// ─── Telnet 协议处理 ──────────────────────────────────────────

// 解析状态
const (
	stateData = iota
	stateIAC
	stateNegotiation
	stateSuboption
	stateSuboptionIAC
)

// telnetParser 把输入流拆成「普通数据」与「对协商命令的应答」。
// IAC 命令可能跨多个读块到达，状态保存在解析器里。
type telnetParser struct {
	state     int
	verb      byte
	subOption byte
	subData   []byte
	hasOption bool
}

// feed 处理一段输入，返回（终端可见数据, 需要发送给对端的应答）。
func (p *telnetParser) feed(data []byte) ([]byte, []byte) {
	plain := make([]byte, 0, len(data))
	replies := make([]byte, 0, 16)

	for _, b := range data {
		switch p.state {
		case stateData:
			if b == telnetIAC {
				p.state = stateIAC
			} else {
				plain = append(plain, b)
			}
		case stateIAC:
			switch b {
			case telnetIAC:
				// 转义的 0xFF 表示字面值
				plain = append(plain, telnetIAC)
				p.state = stateData
			case telnetWILL, telnetWONT, telnetDO, telnetDONT:
				p.verb = b
				p.state = stateNegotiation
			case telnetSB:
				p.state = stateSuboption
				p.subData = p.subData[:0]
				p.hasOption = false
			default:
				// NOP/GA 等单字节命令无需应答
				p.state = stateData
			}
		case stateNegotiation:
			replies = append(replies, negotiationReply(p.verb, b)...)
			p.state = stateData
		case stateSuboption:
			if b == telnetIAC {
				p.state = stateSuboptionIAC
				break
			}
			if !p.hasOption {
				p.subOption = b
				p.hasOption = true
			} else if len(p.subData) < maxSuboptionBytes {
				p.subData = append(p.subData, b)
			}
		case stateSuboptionIAC:
			if b == telnetSE {
				replies = append(replies, suboptionReply(p.subOption, p.subData)...)
				p.state = stateData
			} else if b == telnetIAC {
				// SB 数据中的转义 IAC
				if len(p.subData) < maxSuboptionBytes {
					p.subData = append(p.subData, telnetIAC)
				}
				p.state = stateSuboption
			} else {
				p.state = stateSuboption
			}
		}
	}
	return plain, replies
}

// negotiationReply 决定对 WILL/DO 的应答。只同意项目需要的选项，
// 其余一律拒绝，避免服务端启用 LINEMODE 等未实现的行为。
func negotiationReply(verb byte, option byte) []byte {
	switch verb {
	case telnetWILL:
		switch option {
		case optEcho, optSGA, optBinary:
			return []byte{telnetIAC, telnetDO, option}
		default:
			return []byte{telnetIAC, telnetDONT, option}
		}
	case telnetDO:
		switch option {
		case optSGA, optBinary, optTTYPE, optNAWS:
			return []byte{telnetIAC, telnetWILL, option}
		default:
			return []byte{telnetIAC, telnetWONT, option}
		}
	}
	// WONT/DONT 是对既有协商的回应，不需要再回复（否则会无限协商）
	return nil
}

// suboptionReply 处理子协商：服务端询问终端类型时回复 xterm-256color。
func suboptionReply(option byte, data []byte) []byte {
	if option != optTTYPE || len(data) == 0 || data[0] != 1 { // 1 = SEND
		return nil
	}
	reply := []byte{telnetIAC, telnetSB, optTTYPE, 0} // 0 = IS
	reply = append(reply, []byte("XTERM-256COLOR")...)
	reply = append(reply, telnetIAC, telnetSE)
	return reply
}

// initialTelnetNegotiation 主动告知终端类型/窗口尺寸能力，并要求回显与流控。
func initialTelnetNegotiation() []byte {
	return []byte{
		telnetIAC, telnetWILL, optSGA,
		telnetIAC, telnetWILL, optTTYPE,
		telnetIAC, telnetWILL, optNAWS,
		telnetIAC, telnetDO, optSGA,
		telnetIAC, telnetDO, optEcho,
	}
}

// escapeTelnetIAC 把 0xFF 双写，避免被对端解释为 IAC 命令。
func escapeTelnetIAC(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for _, b := range data {
		out = append(out, b)
		if b == telnetIAC {
			out = append(out, telnetIAC)
		}
	}
	return out
}

// nawsPayload 构造窗口尺寸子协商。宽高值本身若等于 255 也需转义。
func nawsPayload(rows, cols int) []byte {
	out := []byte{telnetIAC, telnetSB, optNAWS}
	appendNAWS := func(value int) []byte {
		hi := byte(value / 256)
		lo := byte(value % 256)
		var buf []byte
		buf = append(buf, hi)
		if hi == telnetIAC {
			buf = append(buf, telnetIAC)
		}
		buf = append(buf, lo)
		if lo == telnetIAC {
			buf = append(buf, telnetIAC)
		}
		return buf
	}
	out = append(out, appendNAWS(cols)...)
	out = append(out, appendNAWS(rows)...)
	out = append(out, telnetIAC, telnetSE)
	return out
}
