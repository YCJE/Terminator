package vault

import (
	"sync"
	"terminator-desktop/backend/internal/apperror"
)

// Vault holds sensitive keys in memory.
// This exists mostly so the keys can be passed around.
// Safe for concurrent access
type Vault struct {
	mutex     sync.RWMutex
	masterKey []byte
	loginKey  []byte
}

func New() *Vault {
	return &Vault{}
}

// Unlock stores keys in memory. Previous keys are securely cleared first.
func (v *Vault) Unlock(masterKey []byte, loginKey []byte) {
	v.mutex.Lock()
	defer v.mutex.Unlock()

	// Clear any existing keys before overwriting to avoid leaving
	// sensitive material in memory awaiting GC.
	clear(v.masterKey)
	clear(v.loginKey)

	// Store copies to prevent callers from mutating internal state.
	// 空切片归一化为 nil：否则 make([]byte, 0) 会得到非 nil 的空切片，
	// IsUnlocked / GetLoginKey 的 nil 判断会失效，调用方可能拿到零长度密钥
	// 而不报错。
	if len(masterKey) > 0 {
		v.masterKey = make([]byte, len(masterKey))
		copy(v.masterKey, masterKey)
	} else {
		v.masterKey = nil
	}

	if len(loginKey) > 0 {
		v.loginKey = make([]byte, len(loginKey))
		copy(v.loginKey, loginKey)
	} else {
		v.loginKey = nil
	}
}

// Lock clears keys from memory
func (v *Vault) Lock() {
	v.mutex.Lock()
	defer v.mutex.Unlock()

	clear(v.masterKey)
	v.masterKey = nil

	clear(v.loginKey)
	v.loginKey = nil
}

// IsUnlocked returns true if we have the master key
func (v *Vault) IsUnlocked() bool {
	v.mutex.RLock()
	defer v.mutex.RUnlock()
	return v.masterKey != nil
}

// GetMasterKey returns a copy of the master key, error if locked.
// Returns a copy to prevent callers from holding references to internal state.
func (v *Vault) GetMasterKey() ([]byte, error) {
	v.mutex.RLock()
	defer v.mutex.RUnlock()

	if v.masterKey == nil {
		return nil, apperror.VaultLocked()
	}
	dst := make([]byte, len(v.masterKey))
	copy(dst, v.masterKey)
	return dst, nil
}

// GetLoginKey returns a copy of the login key, error if locked.
// Returns a copy to prevent callers from holding references to internal state.
func (v *Vault) GetLoginKey() ([]byte, error) {
	v.mutex.RLock()
	defer v.mutex.RUnlock()

	if v.loginKey == nil {
		return nil, apperror.VaultLocked()
	}
	dst := make([]byte, len(v.loginKey))
	copy(dst, v.loginKey)
	return dst, nil
}
