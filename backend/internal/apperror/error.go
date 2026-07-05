package apperror

import (
	"errors"
	"fmt"
)

// AppError something like a generic error or a domain error
type AppError struct {
	Code        ErrorCode
	Message     string
	Err         error
	ErrorString string
}

func (e *AppError) Error() string {
	return e.Message
}

func (e *AppError) Unwrap() error {
	return e.Err
}

func Validation(msg string) *AppError {
	return &AppError{
		Code:        CodeValidationFailed,
		Message:     msg,
		Err:         errors.New(fmt.Sprintf("validation failed: %s", msg)),
		ErrorString: msg,
	}
}

func DecryptionFailed(err error) *AppError {
	message := "invalid password or corrupted data"
	// 不泄露内部错误细节（如 SQL 错误、GCM 认证失败），防止用户枚举攻击
	return &AppError{
		Code:        CodeDecryptionFailed,
		Message:     message,
		Err:         err,
		ErrorString: message,
	}
}

func VaultLocked() *AppError {
	message := "vault is locked"

	return &AppError{
		Code:        CodeVaultLocked,
		Message:     message,
		Err:         errors.New(message),
		ErrorString: message,
	}
}

func NotFound(msg string, err error) *AppError {
	errorString := msg
	if err != nil {
		errorString = err.Error()
	}

	return &AppError{
		Code:        CodeNotFound,
		Message:     msg,
		Err:         err,
		ErrorString: errorString,
	}
}

func Network(err error) *AppError {
	message := "network request failed"
	errorString := message
	if err != nil {
		errorString = err.Error()
	}

	return &AppError{
		Code:        CodeNetworkFailed,
		Message:     message,
		Err:         err,
		ErrorString: errorString,
	}
}

func SSHConnectionFailed(msg string, err error) *AppError {
	errorString := msg
	if err != nil {
		errorString = err.Error()
	}

	return &AppError{
		Code:        CodeSSHConnectionError,
		Message:     msg,
		Err:         err,
		ErrorString: errorString,
	}
}

func SSHSessionNotFound() *AppError {
	message := "session not found"

	return &AppError{
		Code:        CodeSSHSessionNotFound,
		Message:     message,
		Err:         errors.New(message),
		ErrorString: message,
	}
}
