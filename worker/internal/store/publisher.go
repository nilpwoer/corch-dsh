package store

import (
	"context"
	"errors"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/publisherauth"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// CreatePublisherKey stores a digest; the returned plaintext cannot be recovered later.
func (s *Store) CreatePublisherKey(ctx context.Context, name string, expiresAt *time.Time) (publisherauth.Key, string, error) {
	key, token, err := publisherauth.New(name, expiresAt)
	if err != nil {
		return publisherauth.Key{}, "", err
	}
	if err := s.DB.WithContext(ctx).Create(&key).Error; err != nil {
		return publisherauth.Key{}, "", err
	}
	return key, token, nil
}

// ListPublisherKeys returns the latest 200 credentials with no digest or plaintext token.
func (s *Store) ListPublisherKeys(ctx context.Context) ([]publisherauth.Key, error) {
	keys := []publisherauth.Key{}
	err := s.DB.WithContext(ctx).Select("id,name,prefix,status,created_at,last_used_at,expires_at").Order("created_at DESC,id").Limit(200).Find(&keys).Error
	return keys, err
}

// RevokePublisherKey prevents new authorizations; requests already authorized may finish.
func (s *Store) RevokePublisherKey(ctx context.Context, id string) error {
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var key publisherauth.Key
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id=?", id).Take(&key).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return domain.Fail("NOT_FOUND", 404)
			}
			return err
		}
		return tx.Model(&key).Update("status", "revoked").Error
	})
}

// AuthenticatePublisher serializes authorization and revocation, recording successful use only.
func (s *Store) AuthenticatePublisher(ctx context.Context, token string) error {
	hash, ok := publisherauth.Hash(token)
	if !ok {
		return domain.Fail("PUBLISH_AUTH_INVALID", 401)
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var key publisherauth.Key
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("token_hash=? AND status='active' AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(6))", hash).Take(&key).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return domain.Fail("PUBLISH_AUTH_INVALID", 401)
			}
			return err
		}
		return tx.Model(&key).Update("last_used_at", gorm.Expr("UTC_TIMESTAMP(6)")).Error
	})
}
