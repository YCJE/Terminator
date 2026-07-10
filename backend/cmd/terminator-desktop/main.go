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
	"terminator-desktop/backend/cmd/terminator-desktop/emitters"
	"terminator-desktop/backend/cmd/terminator-desktop/env"
	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/migration"
	"terminator-desktop/backend/internal/services/auth"
	"terminator-desktop/backend/internal/services/blob"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/services/sftp"
	"terminator-desktop/backend/internal/services/ssh"
	"terminator-desktop/backend/internal/services/sync"
	"terminator-desktop/backend/internal/services/updater"
	"terminator-desktop/backend/internal/vault"

	"github.com/quaadgras/velopack-go/velopack"
	_ "modernc.org/sqlite" // pure-Go SQLite driver, no CGO required

	root "terminator-desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
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

	application.RegisterEvent[emitters.SFTPTransferProgressPayload](emitters.SFTPProgressEvent)
	application.RegisterEvent[emitters.SFTPTransferCompletePayload](emitters.SFTPCompleteEvent)

	application.RegisterEvent[uint](emitters.UpdaterProgressEvent)
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

	var mainWindow *application.WebviewWindow

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
				if mainWindow != nil {
					mainWindow.Restore()
					mainWindow.Focus()
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

	authService := auth.NewAuthService(queries, db, v, client)
	// settingsService 需在 syncService 之前创建，以便注入到 SyncService
	settingsService := settings.NewSettingsService(appDir)
	syncService := sync.NewSyncService(queries, client, v, syncEmitter, nil, settingsService)
	sshService := ssh.NewSshService(sshEmitter)
	// sftpService 复用 sshService 的 SSH 连接提供文件管理能力
	sftpService := sftp.NewSftpService(sshService, sftpEmitter)
	hostService := blob.NewHostService(queries, v)
	keyService := blob.NewKeyService(queries, v)
	updaterService := updater.NewUpdaterService(updateUrl, githubRepo, updaterEmitter)

	// 注入 SSH 服务到 AuthService，使 WipeData 能断开所有连接
	authService.SetSessionDisconnector(sshService)

	app.RegisterService(application.NewService(authService))
	app.RegisterService(application.NewService(syncService))
	app.RegisterService(application.NewService(sshService))
	app.RegisterService(application.NewService(sftpService))
	app.RegisterService(application.NewService(hostService))
	app.RegisterService(application.NewService(keyService))
	app.RegisterService(application.NewService(settingsService))
	app.RegisterService(application.NewService(updaterService))
	app.RegisterService(application.NewService(NewWebDAVService(settingsService)))

	// Create a new window with the necessary options.
	// 'Title' is the title of the window.
	// 'Mac' options tailor the window when running on macOS.
	// 'BackgroundColour' is the background colour of the window.
	// 'URL' is the URL that will be loaded into the webview.
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
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
	})

	defer v.Lock() // eh why not
	defer syncService.StopAutoSync()
	defer sshService.DisconnectAll() // 优雅断开所有 SSH 会话

	// Run the application. This blocks until the application has been exited.
	err = app.Run()

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
