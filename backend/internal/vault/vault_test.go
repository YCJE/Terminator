package vault

import (
	"errors"
	"testing"

	"terminator-desktop/backend/internal/apperror"
)

// 锁定状态下必须返回错误而不是 nil key：调用方若拿到 nil 继续走加密流程，
// 会退化成使用零值密钥。
func TestLockedVaultReturnsErrorNotNilKey(t *testing.T) {
	v := New()

	if v.IsUnlocked() {
		t.Fatal("新建的 vault 不应处于解锁状态")
	}

	if key, err := v.GetMasterKey(); err == nil || key != nil {
		t.Errorf("锁定时 GetMasterKey 应返回错误与 nil，实际 key=%v err=%v", key, err)
	}
	if key, err := v.GetLoginKey(); err == nil || key != nil {
		t.Errorf("锁定时 GetLoginKey 应返回错误与 nil，实际 key=%v err=%v", key, err)
	}

	var appErr *apperror.AppError
	if _, err := v.GetMasterKey(); !errors.As(err, &appErr) || appErr.Code != apperror.CodeVaultLocked {
		t.Errorf("期望 VAULT_LOCKED 错误，实际 %v", err)
	}
}

// GetMasterKey 必须返回副本：调用方修改返回值不能污染 vault 内部状态。
func TestGetMasterKeyReturnsCopy(t *testing.T) {
	v := New()
	v.Unlock([]byte{1, 2, 3}, []byte{4, 5, 6})

	got, err := v.GetMasterKey()
	if err != nil {
		t.Fatalf("GetMasterKey 失败: %v", err)
	}
	got[0] = 99

	again, err := v.GetMasterKey()
	if err != nil {
		t.Fatalf("GetMasterKey 失败: %v", err)
	}
	if again[0] != 1 {
		t.Errorf("修改返回值污染了内部状态: %v", again)
	}
}

// Unlock 必须拷贝入参：调用方随后清空自己持有的切片，不应影响 vault。
func TestUnlockCopiesInput(t *testing.T) {
	v := New()
	master := []byte{1, 2, 3}
	login := []byte{4, 5, 6}

	v.Unlock(master, login)
	clear(master)
	clear(login)

	got, err := v.GetMasterKey()
	if err != nil {
		t.Fatalf("GetMasterKey 失败: %v", err)
	}
	if len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Errorf("vault 持有的密钥被调用方清空操作影响: %v", got)
	}
}

// Lock 之后必须回到未解锁状态且取不到密钥。
func TestLockClearsKeys(t *testing.T) {
	v := New()
	v.Unlock([]byte{1, 2, 3}, []byte{4, 5, 6})

	if !v.IsUnlocked() {
		t.Fatal("Unlock 后应处于解锁状态")
	}

	v.Lock()

	if v.IsUnlocked() {
		t.Error("Lock 后仍报告已解锁")
	}
	if _, err := v.GetMasterKey(); err == nil {
		t.Error("Lock 后仍能取到主密钥")
	}
	if _, err := v.GetLoginKey(); err == nil {
		t.Error("Lock 后仍能取到登录密钥")
	}
}

// 重复 Unlock 时旧密钥必须先被清零，避免敏感material 残留等待 GC。
func TestUnlockReplacesPreviousKeys(t *testing.T) {
	v := New()
	v.Unlock([]byte{1, 1, 1}, []byte{2, 2, 2})
	v.Unlock([]byte{9}, []byte{8})

	master, err := v.GetMasterKey()
	if err != nil {
		t.Fatalf("GetMasterKey 失败: %v", err)
	}
	if len(master) != 1 || master[0] != 9 {
		t.Errorf("主密钥未替换为最新值: %v", master)
	}

	login, err := v.GetLoginKey()
	if err != nil {
		t.Fatalf("GetLoginKey 失败: %v", err)
	}
	if len(login) != 1 || login[0] != 8 {
		t.Errorf("登录密钥未替换为最新值: %v", login)
	}
}

// 解锁状态只取决于主密钥是否持有。
func TestIsUnlockedFollowsMasterKey(t *testing.T) {
	v := New()
	v.Unlock([]byte{1}, nil)

	if !v.IsUnlocked() {
		t.Error("持有主密钥时应报告已解锁")
	}
	if _, err := v.GetLoginKey(); err == nil {
		t.Error("登录密钥为空时应返回错误")
	}
}
