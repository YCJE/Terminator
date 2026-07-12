package blob

import (
	"context"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/vault"

	"github.com/google/uuid"
)

// wrappers for wails

type HostService struct {
	q *dbgen.Queries
	v *vault.Vault
}

func NewHostService(q *dbgen.Queries, v *vault.Vault) *HostService {
	return &HostService{q: q, v: v}
}

func (s *HostService) Save(ctx context.Context, host Host) (string, error) {
	if host.ID == "" {
		host.ID = uuid.New().String()
	}
	host.Type = TypeHost // just in case
	return saveItem(ctx, s.q, s.v, host.ID, host)
}

func (s *HostService) GetAll(ctx context.Context) ([]Host, error) {
	return getAllItems[Host](ctx, s.q, s.v, TypeHost)
}

func (s *HostService) Delete(ctx context.Context, id string) error {
	return deleteItem(ctx, s.q, s.v, id)
}

type KeyService struct {
	q *dbgen.Queries
	v *vault.Vault
}

func NewKeyService(q *dbgen.Queries, v *vault.Vault) *KeyService {
	return &KeyService{q: q, v: v}
}

func (s *KeyService) Save(ctx context.Context, key SavedKey) (string, error) {
	if key.ID == "" {
		key.ID = uuid.New().String()
	}
	key.Type = TypeKey // just in case
	return saveItem(ctx, s.q, s.v, key.ID, key)
}

func (s *KeyService) GetAll(ctx context.Context) ([]SavedKey, error) {
	return getAllItems[SavedKey](ctx, s.q, s.v, TypeKey)
}

func (s *KeyService) Delete(ctx context.Context, id string) error {
	return deleteItem(ctx, s.q, s.v, id)
}

// SnippetService 提供代码片段的 CRUD 操作（Wails 绑定）
type SnippetService struct {
	q *dbgen.Queries
	v *vault.Vault
}

func NewSnippetService(q *dbgen.Queries, v *vault.Vault) *SnippetService {
	return &SnippetService{q: q, v: v}
}

func (s *SnippetService) Save(ctx context.Context, snippet Snippet) (string, error) {
	if snippet.ID == "" {
		snippet.ID = uuid.New().String()
	}
	snippet.Type = TypeSnippet // 确保类型正确
	return saveItem(ctx, s.q, s.v, snippet.ID, snippet)
}

func (s *SnippetService) GetAll(ctx context.Context) ([]Snippet, error) {
	return getAllItems[Snippet](ctx, s.q, s.v, TypeSnippet)
}

func (s *SnippetService) Delete(ctx context.Context, id string) error {
	return deleteItem(ctx, s.q, s.v, id)
}
