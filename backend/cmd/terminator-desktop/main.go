package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	stdSync "sync" // 本项目也有名为 sync 的服务包，标准库需起别名区分
	"sync/atomic"
	"terminator-desktop/backend/cmd/terminator-desktop/emitters"
	"terminator-desktop/backend/cmd/terminator-desktop/env"
	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/migration"
	"terminator-desktop/backend/internal/services/auth"
	"terminator-desktop/backend/internal/services/backup"
	"terminator-desktop/backend/internal/services/batch"
	"terminator-desktop/backend/internal/services/blob"
	"terminator-desktop/backend/internal/services/editor"
	"terminator-desktop/backend/internal/services/fileio"
	"terminator-desktop/backend/internal/services/floating"
	"terminator-desktop/backend/internal/services/local"
	"terminator-desktop/backend/internal/services/monitor"
	"terminator-desktop/backend/internal/services/netconn"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/services/sftp"
	"terminator-desktop/backend/internal/services/ssh"
	"terminator-desktop/backend/internal/services/sync"
	"terminator-desktop/backend/internal/services/updater"
	"terminator-desktop/backend/internal/vault"
	"time"

	"github.com/quaadgras/velopack-go/velopack"
	_ "modernc.org/sqlite" // pure-Go SQLite driver, no CGO required

	root "terminator-desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func init() {
	// Register a custom event whose associated data type is string.
	// This is not required, but the binding generator will pick up registered events
	// and provide a strongly typed JS/TS API for them.

	application.RegisterEvent[sync.SyncStatus](emitters.SyncStatusEvent)
	application.RegisterEvent[emitters.SyncErrorPayload](emitters.SyncErrorEvent)
	application.RegisterEvent[bool](emitters.SyncUpdatesAvailableEvent)

	application.RegisterEvent[emitters.SSHDataPayload](emitters.SSHDataEvent)
	application.RegisterEvent[emitters.SSHClosedPayload](emitters.SSHClosedEvent)
	application.RegisterEvent[emitters.SSHAuthPromptPayload](emitters.SSHAuthPromptEvent)

	application.RegisterEvent[emitters.SFTPTransferProgressPayload](emitters.SFTPProgressEvent)
	application.RegisterEvent[emitters.SFTPTransferCompletePayload](emitters.SFTPCompleteEvent)

	application.RegisterEvent[monitor.MonitorSample](emitters.MonitorSampleEvent)
	application.RegisterEvent[emitters.MonitorErrorPayload](emitters.MonitorErrorEvent)

	application.RegisterEvent[emitters.FileDropPayload](emitters.FileDropEvent)

	application.RegisterEvent[uint](emitters.UpdaterProgressEvent)

	// 浮动窗口请求回到主窗口：载荷包含会话 ID 与连接参数
	application.RegisterEvent[floating.DockPayload](floating.DockRequestEvent)

	// 外部编辑器自动回传结果
	application.RegisterEvent[emitters.EditorSavedPayload](emitters.EditorSavedEvent)
}

const AppName = "Terminator"
const dbFile = "terminator.db"
const devDbFile = "dev.db"
const logFileName = "terminator.log"
const crashLogFileName = "crash.log"
const updateUrl = "https://github.com/YCJE/Terminator/releases/latest/download/"
const githubRepo = "YCJE/Terminator"

func main() {
	velopack.Run(velopack.App{
		AutoApplyOnStartup: true,
	})

	for _, arg := range os.Args {
		switch arg {
		case "--veloapp-install",
			"--veloapp-uninstall",
			"--veloapp-obsolete":
			os.Exit(0)
		}
	}

	isDebug := env.IsDebug

	appDir, err := getAppDir(isDebug)
	if err != nil {
		log.Fatal(fmt.Errorf("error getting app directory: %w", err))
	}

	logPath := filepath.Join(appDir, logFileName)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		log.Fatal(fmt.Errorf("error opening log file: %w", err))
	}
	defer func(logFile *os.File) {
		_ = logFile.Close()
	}(logFile)

	var multiWriter io.Writer
	if isDebug {
		multiWriter = io.MultiWriter(os.Stdout, logFile)
	} else {
		multiWriter = io.MultiWriter(logFile)
	}
	logger := slog.New(&filteredHandler{wrapped: slog.NewTextHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})})
	slog.SetDefault(logger)

	crashPath := filepath.Join(appDir, crashLogFileName)
	crashFile, err := os.OpenFile(crashPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		log.Fatal(fmt.Errorf("error opening crash log file: %w", err))
	}
	err = debug.SetCrashOutput(crashFile, debug.CrashOptions{})
	if err != nil {
		log.Fatal(fmt.Errorf("error setting crash output: %w", err))
	}

	slog.Info("Environment", "IsDebug", isDebug)

	// 第二实例回调由 Wails 的监听 goroutine 执行，与下方窗口创建并发，
	// 用原子指针避免在未同步的情况下读写窗口句柄（-race 可复现）。
	var mainWindow atomic.Pointer[application.WebviewWindow]

	// Create a new Wails application by providing the necessary options.
	// Variables 'Name' and 'Description' are for application metadata.
	// 'Assets' configures the asset server with the 'FS' variable pointing to the frontend files.
	// 'Bind' is a list of Go struct instances. The frontend has access to the methods of these instances.
	// 'Mac' options tailor the application when running an macOS.
	app := application.New(application.Options{
		Name:        AppName,
		Description: "SSH client",
		Logger:      logger,
		//Services: []application.Service{
		//},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(root.Frontend),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{
			WebviewUserDataPath: filepath.Join(appDir, "webview2"),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.terminator.desktop",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if w := mainWindow.Load(); w != nil {
					// 隐藏到托盘后再次启动，Restore 不会重新显示窗口，需先 Show。
					// Restore 只在最小化时调用：它会顺带取消最大化状态。
					w.Show()
					if w.IsMinimised() {
						w.Restore()
					}
					w.Focus()
				}

				slog.Info("Second instance launched", "args", data.Args)
				slog.Info("Working directory", "dir", data.WorkingDir)
				slog.Info("Additional data", "data", data.AdditionalData)
			},
		},
	})

	dbPath := getDbDir(appDir, isDebug)
	// 启用 WAL 模式 + busy_timeout，防止并发读写时 "database is locked"
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatal(fmt.Errorf("error building db: %w", err))
	}
	// 限制最大连接数，SQLite 单写入者模型下多连接反而增加锁竞争
	db.SetMaxOpenConns(1)
	defer func(db *sql.DB) {
		_ = db.Close()
	}(db)
	queries := dbgen.New(db)

	err = migration.RunMigrations(db)
	if err != nil {
		log.Fatal(fmt.Errorf("error migrating db: %w", err))
	}

	v := vault.New()
	client := api.NewClient()

	syncEmitter := emitters.NewWailsSyncEmitter(app)
	sshEmitter := emitters.NewWailsSSHEmitter(app)
	updaterEmitter := emitters.NewWailsUpdaterEmitter(app)
	sftpEmitter := emitters.NewWailsSFTPEmitter(app)
	monitorEmitter := emitters.NewWailsMonitorEmitter(app)
	editorEmitter := emitters.NewWailsEditorEmitter(app)

	// 会话日志目录
	sshLogDir := filepath.Join(appDir, "ssh-logs")
	if err := os.MkdirAll(sshLogDir, 0700); err != nil {
		log.Fatal(fmt.Errorf("error creating SSH log directory: %w", err))
	}

	authService := auth.NewAuthService(queries, db, v, client)
	// settingsService 需在 syncService 之前创建，以便注入到 SyncService
	settingsService := settings.NewSettingsService(appDir)
	syncService := sync.NewSyncService(queries, db, client, v, syncEmitter, nil, settingsService)
	sshService := ssh.NewSshService(sshEmitter, sshLogDir)
	// 交互式认证（MFA/OTP）：服务器发起问答时推送到前端弹窗填写
	sshService.SetAuthPrompter(sshEmitter)

	// 会话日志默认关闭，开关由设置实时控制；启动时按保留期回收历史日志，
	// 避免含口令/令牌的终端内容无限期留在磁盘上。
	sshService.SetSessionLogConfig(settingsService)
	if removed, err := ssh.CleanupSessionLogs(sshLogDir, settingsService.SessionLogRetentionDays()); err != nil {
		slog.Warn("failed to clean up session logs", "error", err)
	} else if removed > 0 {
		slog.Info("cleaned up expired session logs", "removed", removed)
	}
	// sftpService 复用 sshService 的 SSH 连接提供文件管理能力
	sftpService := sftp.NewSftpService(sshService, sftpEmitter)
	// 外部编辑器：下载远端文件到临时目录、用系统默认程序打开并监听保存回传
	editorService := editor.NewService(sshService, sftpService, editorEmitter)
	// 批量执行：在多台已连接服务器上并发跑同一条命令
	batchService := batch.NewService(sshService)
	// 监控采集同样复用 SSH 连接：每个会话一个采集循环，断开或出错即停
	monitorService := monitor.NewMonitorService(sshService, monitorEmitter)
	// Telnet / 串口会话：与 SSH 共用数据事件，终端组件无需区分数据来源
	netConnService := netconn.NewService(sshEmitter)
	// 本地终端复用 SSH 的数据事件通道，前端无需区分数据来源
	localShellService := local.NewLocalShellService(sshEmitter)
	hostService := blob.NewHostService(queries, v)
	keyService := blob.NewKeyService(queries, v)
	snippetService := blob.NewSnippetService(queries, v) // 代码片段服务
	updaterService := updater.NewUpdaterService(updateUrl, githubRepo, updaterEmitter)
	// 备份导出/导入：内容为密文，需原登录口令才能还原
	backupService := backup.NewBackupService(queries, db, v, client, newWailsFileDialog(app), func() string {
		return updater.Version
	})

	// 注入 SSH 服务到 AuthService，使 WipeData 能断开所有连接
	authService.SetSessionDisconnector(sessionDisconnectors{sshService, netConnService})
	// 导入会整体替换主机列表，同样需要先断开所有连接
	backupService.SetSessionDisconnector(sessionDisconnectors{sshService, netConnService})
	// 擦除/导入会整体替换本地数据，期间必须暂停后台同步，
	// 否则在途同步会把替换前的旧条目推回服务器
	authService.SetSyncPauser(syncService)
	backupService.SetSyncPauser(syncService)

	app.RegisterService(application.NewService(authService))
	app.RegisterService(application.NewService(syncService))
	app.RegisterService(application.NewService(sshService))
	app.RegisterService(application.NewService(sftpService))
	app.RegisterService(application.NewService(editorService))
	app.RegisterService(application.NewService(batchService))
	app.RegisterService(application.NewService(monitorService))
	app.RegisterService(application.NewService(netConnService))
	app.RegisterService(application.NewService(localShellService))
	app.RegisterService(application.NewService(hostService))
	app.RegisterService(application.NewService(keyService))
	app.RegisterService(application.NewService(snippetService)) // 注册代码片段服务
	// 文本文件读写：终端缓冲区导出、代码片段导入导出
	app.RegisterService(application.NewService(fileio.NewTextFileService()))
	app.RegisterService(application.NewService(settingsService))
	app.RegisterService(application.NewService(updaterService))
	app.RegisterService(application.NewService(backupService))
	app.RegisterService(application.NewService(NewWebDAVService(settingsService)))
	// 浮动终端窗口：会话仍由 SSH/本地终端服务持有，窗口只是另一个视图
	app.RegisterService(application.NewService(
		floating.NewService(app, sshService.Disconnect, localShellService.Close),
	))

	// Create a new window with the necessary options.
	// 'Title' is the title of the window.
	// 'Mac' options tailor the window when running on macOS.
	// 'BackgroundColour' is the background colour of the window.
	// 'URL' is the URL that will be loaded into the webview.
	// 恢复上次的窗口尺寸与最大化状态。位置不在此处直接套用：
	// Wails 要到 Run() 阶段才枚举显示器，此时套用旧坐标可能落到已拔掉的显示器上，
	// 窗口就再也看不见了，因此留到窗口就绪后按实际显示器校验再设置。
	savedWindowState := settingsService.LoadWindowState()
	windowOptions := application.WebviewWindowOptions{
		Title:          AppName,
		EnableFileDrop: true,
		Frameless:      runtime.GOOS == "windows",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(9, 9, 11),
		URL:              "/",
		// 最小尺寸：低于该宽度时标题栏操作区与双栏内容无法优雅排布。
		// 设置页自身也会在窄卡片下切换为上下堆叠布局（见 main.css 的容器查询）。
		MinWidth:  720,
		MinHeight: 480,
		// 没有保存状态时居中显示
		InitialPosition: application.WindowCentered,
	}
	if savedWindowState.Width > 0 && savedWindowState.Height > 0 {
		// 旧版本可能保存过小于新下限的尺寸，恢复时收敛到最小值；
		// 否则窗口会以低于 MinWidth 的尺寸创建，首次拖动才被系统纠正。
		windowOptions.Width = max(savedWindowState.Width, windowOptions.MinWidth)
		windowOptions.Height = max(savedWindowState.Height, windowOptions.MinHeight)
	}
	if savedWindowState.Maximised {
		windowOptions.StartState = application.WindowStateMaximised
	}

	mainWin := app.Window.NewWithOptions(windowOptions)
	mainWindow.Store(mainWin)

	// ---- 窗口状态记忆 ----
	// 拖动/缩放会连续触发窗口事件，合并成 500ms 一次的写盘，避免频繁 IO。
	var windowStateMu stdSync.Mutex
	windowState := savedWindowState
	var windowStateTimer *time.Timer

	persistWindowState := func() {
		windowStateMu.Lock()
		snapshot := windowState
		windowStateMu.Unlock()
		if err := settingsService.SaveWindowState(snapshot); err != nil {
			slog.Warn("failed to persist window state", "error", err)
		}
	}

	scheduleWindowStateSave := func() {
		windowStateMu.Lock()
		if windowStateTimer != nil {
			windowStateTimer.Stop()
		}
		windowStateTimer = time.AfterFunc(500*time.Millisecond, persistWindowState)
		windowStateMu.Unlock()
	}

	// flushWindowState 取消尚未触发的防抖并立即落盘。
	// 关闭窗口与退出应用都要走这里，否则最后一次拖动/缩放的记录会丢。
	flushWindowState := func() {
		windowStateMu.Lock()
		if windowStateTimer != nil {
			windowStateTimer.Stop()
			windowStateTimer = nil
		}
		snapshot := windowState
		windowStateMu.Unlock()
		if err := settingsService.SaveWindowState(snapshot); err != nil {
			slog.Warn("failed to persist window state", "error", err)
		}
	}

	// captureWindowGeometry 记录当前窗口几何。
	// 最大化期间不记录尺寸/位置：此时尺寸是全屏尺寸，记录下来会让下次启动的
	// "普通尺寸"变成全屏；取消最大化后窗口会重新触发 resize，届时再记录真实几何。
	captureWindowGeometry := func() {
		if mainWin.IsMaximised() {
			windowStateMu.Lock()
			windowState.Maximised = true
			windowStateMu.Unlock()
			scheduleWindowStateSave()
			return
		}
		x, y := mainWin.Position()
		width, height := mainWin.Size()
		// 窗口正在销毁时拿到的尺寸是 0，写入后会覆盖掉有效记录
		if width <= 0 || height <= 0 {
			return
		}
		windowStateMu.Lock()
		windowState.Maximised = false
		windowState.HasPos = true
		windowState.X, windowState.Y = x, y
		windowState.Width, windowState.Height = width, height
		windowStateMu.Unlock()
		scheduleWindowStateSave()
	}

	// 窗口事件回调在独立 goroutine 中执行，可安全调用 InvokeSync 类方法
	mainWin.OnWindowEvent(events.Common.WindowDidResize, func(*application.WindowEvent) {
		captureWindowGeometry()
	})
	mainWin.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) {
		captureWindowGeometry()
	})
	mainWin.OnWindowEvent(events.Common.WindowMaximise, func(*application.WindowEvent) {
		captureWindowGeometry()
	})
	mainWin.OnWindowEvent(events.Common.WindowUnMaximise, func(*application.WindowEvent) {
		captureWindowGeometry()
	})
	// 关闭前同步落盘一次：拖拽/缩放最后一次变化的 500ms 防抖可能在退出前
	// 还没触发，直接退出会丢掉最后的尺寸/位置
	mainWin.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		flushWindowState()
	})

	// 窗口就绪后套用保存的位置（仅当它仍落在某个显示器的可用区域内）
	if savedWindowState.HasPos && !savedWindowState.Maximised {
		mainWin.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
			if !windowPositionVisible(app, savedWindowState) {
				return
			}
			mainWin.SetPosition(savedWindowState.X, savedWindowState.Y)
		})
	}

	// ---- 系统托盘 ----
	// 开启"关闭到托盘"后，关闭窗口只隐藏到通知区域。托盘图标惰性创建：
	// 只有真正隐藏过一次窗口后才出现，平时不占用通知区域的位置。
	var trayOnce stdSync.Once
	var systemTray *application.SystemTray
	showMainWindow := func() {
		mainWin.Show()
		// 只在最小化时才 Restore：Restore 会同时取消最大化状态，
		// 对"最大化后隐藏到托盘"的窗口会把用户的最大化布局弄丢。
		if mainWin.IsMinimised() {
			mainWin.Restore()
		}
		mainWin.Focus()
	}
	ensureTray := func() *application.SystemTray {
		trayOnce.Do(func() {
			showLabel, quitLabel := "显示主窗口", "退出"
			if st, err := settingsService.GetSettings(); err == nil && st.Language != "zh" {
				showLabel, quitLabel = "Show Terminator", "Quit"
			}
			tray := app.SystemTray.New()
			tray.SetIcon(root.AppIcon)
			tray.SetTooltip(AppName)
			menu := application.NewMenu()
			menu.Add(showLabel).OnClick(func(*application.Context) {
				showMainWindow()
			})
			menu.AddSeparator()
			// 走 app.Quit 而非窗口关闭：关闭事件会被上面的钩子拦下，导致退不出去
			menu.Add(quitLabel).OnClick(func(*application.Context) {
				app.Quit()
			})
			tray.SetMenu(menu)
			tray.OnClick(showMainWindow)
			tray.Show()
			systemTray = tray
		})
		return systemTray
	}

	// 关闭事件钩子：在 Wails 内置的"关闭即销毁"监听器之前执行，
	// Cancel 后窗口保持存活，改为隐藏到托盘。
	// 钩子运行在 UI 线程且为同步调用，窗口操作必须转到主循环，否则 InvokeSync 会死锁。
	mainWin.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		st, err := settingsService.GetSettings()
		if err != nil || !st.CloseToTray {
			return
		}
		event.Cancel()
		go func() {
			ensureTray()
			mainWin.Hide()
		}()
	})

	// 外部文件拖放：WebView2 不允许网页读取本地文件绝对路径，
	// 由 Wails 把路径交给 Go，再连同拖放目标元素上的会话信息转发给前端。
	mainWin.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		ctx := event.Context()
		files := ctx.DroppedFiles()
		if len(files) == 0 {
			return
		}
		payload := emitters.FileDropPayload{Files: files}
		if target := ctx.DropTargetDetails(); target != nil {
			payload.SessionID = target.Attributes["data-session-id"]
			payload.Kind = target.Attributes["data-drop-kind"]
		}
		app.Event.Emit(emitters.FileDropEvent, payload)
	})

	defer v.Lock() // eh why not
	defer syncService.StopAutoSync()
	defer sshService.DisconnectAll() // 优雅断开所有 SSH 会话
	defer netConnService.CloseAll()
	defer localShellService.CloseAll()

	// Run the application. This blocks until the application has been exited.
	err = app.Run()

	// 经托盘菜单退出走的是 app.Quit()，不触发 WindowClosing，这里补写最后一次窗口状态
	flushWindowState()

	// If an error occurred while running the application, log it.
	// 不使用 log.Fatal，因为它会调用 os.Exit 跳过所有 defer
	if err != nil {
		log.Printf("application error: %v", err)
	}
}

func getAppDir(isDebug bool) (string, error) {
	if isDebug {
		executablePath, err := os.Executable()
		if err != nil {
			return "", err
		}
		executableDir := filepath.Dir(executablePath)
		return filepath.Join(executableDir, ".."), nil
	}

	userDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	appDir := filepath.Join(userDir, AppName)

	if err = os.MkdirAll(appDir, 0755); err != nil {
		return "", err
	}

	return appDir, nil
}

func getDbDir(appDir string, isDebug bool) string {
	if isDebug {
		return filepath.Join(appDir, devDbFile)
	}
	return filepath.Join(appDir, dbFile)
}

// windowPositionVisible 判断保存的窗口位置是否仍落在某个显示器的可用区域内。
// 只要求窗口左上角的一小块（200x80）与工作区相交：显示器分辨率变小后窗口
// 可能比屏幕还大，只要左上角可见就是可接受的位置；完全落在屏幕外（例如
// 副屏被拔掉、显示器重新排列）则放弃套用，退回居中以避免"窗口看不见"。
func windowPositionVisible(app *application.App, st settings.WindowState) bool {
	screens := app.Screen.GetAll()
	if len(screens) == 0 {
		return false
	}
	probeW, probeH := 200, 80
	if st.Width > 0 && st.Width < probeW {
		probeW = st.Width
	}
	for _, screen := range screens {
		area := screen.WorkArea
		if st.X+probeW > area.X && st.X < area.X+area.Width &&
			st.Y+probeH > area.Y && st.Y < area.Y+area.Height {
			return true
		}
	}
	return false
}

// sessionDisconnectors 汇总多个服务的断开操作，供擦除/导入等整体替换数据的流程使用。
// SSH 与 Telnet/串口是独立服务，但都要在数据被清除前断开。
type sessionDisconnectors []interface{ DisconnectAll() }

func (s sessionDisconnectors) DisconnectAll() {
	for _, item := range s {
		item.DisconnectAll()
	}
}

// filteredHandler 包装 slog.Handler，过滤掉已知的非错误日志
// 例如用户取消文件选择对话框时 Wails 框架会记录 ERROR 级别日志，
// 但这是正常用户操作，不应记录为错误
type filteredHandler struct {
	wrapped slog.Handler
}

// shouldSuppress 检查是否应抑制该日志条目
func (h *filteredHandler) shouldSuppress(level slog.Level, msg string) bool {
	if level < slog.LevelError {
		return false
	}
	// 用户取消文件选择对话框不是错误
	if strings.Contains(msg, "cancelled by user") {
		return true
	}
	return false
}

func (h *filteredHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.wrapped.Enabled(ctx, level)
}

func (h *filteredHandler) Handle(ctx context.Context, r slog.Record) error {
	if h.shouldSuppress(r.Level, r.Message) {
		return nil
	}
	return h.wrapped.Handle(ctx, r)
}

func (h *filteredHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &filteredHandler{wrapped: h.wrapped.WithAttrs(attrs)}
}

func (h *filteredHandler) WithGroup(name string) slog.Handler {
	return &filteredHandler{wrapped: h.wrapped.WithGroup(name)}
}
