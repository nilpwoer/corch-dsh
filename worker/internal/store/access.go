package store

import (
	"context"
	"errors"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/packaccess"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type packAccess struct {
	PackKey         string `gorm:"primaryKey"`
	PublicationHash string
	Revision        int64
	Code            string
	Status          string
	Source          string
}

func (packAccess) TableName() string { return "tw_pack_access" }
func accessView(r packAccess) packaccess.View {
	return packaccess.View{Revision: r.Revision, PublicationHash: r.PublicationHash, Code: r.Code, Status: r.Status, Source: r.Source}
}

// ReadPackAccess returns recoverable participant credentials only to its management consumer.
// Missing rows retain existing immutable publication codes without automatic migration.
func (s *Store) ReadPackAccess(ctx context.Context, entry published.Entry) (packaccess.View, error) {
	var row packAccess
	err := s.DB.WithContext(ctx).Where("pack_key=?", entry.Key).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return packaccess.Legacy(entry), nil
	}
	if err != nil {
		return packaccess.View{}, err
	}
	if row.PublicationHash != entry.Hash {
		return packaccess.View{}, domain.Fail("ACCESS_PUBLICATION_CHANGED", 409)
	}
	if row.Revision < 1 || len(row.Code) < 1 || len(row.Code) > 128 || (row.Status != "active" && row.Status != "revoked") || (row.Source != "worker" && row.Source != "legacy") {
		return packaccess.View{}, domain.Fail("INVALID_SAVED_ACCESS", 500)
	}
	return accessView(row), nil
}

// EnsurePackAccess creates a code only for a new publication without a legacy invitation.
// The winning unique-key row supplies every same-version retry, including concurrent requests.
func (s *Store) EnsurePackAccess(ctx context.Context, entry published.Entry) (packaccess.View, error) {
	existing, err := s.ReadPackAccess(ctx, entry)
	if err != nil || existing.Status != "missing" {
		return existing, err
	}
	code, err := packaccess.Generate()
	if err != nil {
		return packaccess.View{}, err
	}
	err = s.DB.WithContext(ctx).Exec("INSERT INTO tw_pack_access(pack_key,publication_hash,revision,code,status,source) VALUES (?,?,1,?,'active','worker') ON DUPLICATE KEY UPDATE pack_key=pack_key", entry.Key, entry.Hash, code).Error
	if err != nil {
		return packaccess.View{}, err
	}
	return s.ReadPackAccess(ctx, entry)
}

// ChangePackAccess requires explicit admin intent and a revision, preserving active sessions.
func (s *Store) ChangePackAccess(ctx context.Context, entry published.Entry, revision int64, action string) (packaccess.View, error) {
	if action != "create" && action != "rotate" && action != "revoke" {
		return packaccess.View{}, domain.Fail("INVALID_ACCESS_ACTION", 400)
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		legacy := packaccess.Legacy(entry)
		if err := tx.Exec("INSERT INTO tw_pack_access(pack_key,publication_hash,revision,code,status,source) VALUES (?,?,0,?,?,?) ON DUPLICATE KEY UPDATE pack_key=pack_key", entry.Key, entry.Hash, legacy.Code, legacy.Status, legacy.Source).Error; err != nil {
			return err
		}
		var row packAccess
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("pack_key=?", entry.Key).Take(&row).Error; err != nil {
			return err
		}
		if row.PublicationHash != entry.Hash {
			return domain.Fail("ACCESS_PUBLICATION_CHANGED", 409)
		}
		if row.Revision != revision {
			return domain.Fail("ACCESS_REVISION_CONFLICT", 409)
		}
		if action == "create" && row.Code != "" {
			return domain.Fail("ACCESS_ALREADY_EXISTS", 409)
		}
		if action == "revoke" {
			if row.Code == "" {
				return domain.Fail("ACCESS_NOT_INITIALIZED", 409)
			}
			row.Status = "revoked"
		} else {
			code, err := packaccess.Rotate(row.Code)
			if err != nil {
				return err
			}
			row.Code = code
			row.Status = "active"
			row.Source = "worker"
		}
		return tx.Model(&packAccess{}).Where("pack_key=?", entry.Key).Updates(map[string]any{"revision": row.Revision + 1, "code": row.Code, "status": row.Status, "source": row.Source}).Error
	})
	if err != nil {
		return packaccess.View{}, err
	}
	return s.ReadPackAccess(ctx, entry)
}

// CheckPackAccess reads authoritative state; it never initializes missing credentials.
func (s *Store) CheckPackAccess(ctx context.Context, entry published.Entry, code string) error {
	v, err := s.ReadPackAccess(ctx, entry)
	if err != nil {
		return err
	}
	return packaccess.Check(v, code)
}
