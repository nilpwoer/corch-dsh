// Package publisherauth defines upload-only credentials; participant invitations use packaccess.
package publisherauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/google/uuid"
)

// Key is safe to list; its digest is never serialized and its token is never retained.
type Key struct {
	ID         string     `json:"id" gorm:"primaryKey"`
	Name       string     `json:"name"`
	TokenHash  string     `json:"-"`
	Prefix     string     `json:"prefix"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

func (Key) TableName() string { return "tw_publisher_keys" }

// Hash accepts only publisher tokens, preventing confusion with model keys or invitation codes.
func Hash(token string) (string, bool) {
	if len(token) != 72 || !strings.HasPrefix(token, "dsh_pub_") {
		return "", false
	}
	if _, err := hex.DecodeString(token[8:]); err != nil || token[8:] != strings.ToLower(token[8:]) {
		return "", false
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:]), true
}

// New returns a one-time plaintext token separately from the persistable hash-only record.
func New(name string, expiresAt *time.Time) (Key, string, error) {
	name = strings.TrimSpace(name)
	now := time.Now().UTC()
	if name == "" || utf8.RuneCountInString(name) > 100 || expiresAt != nil && !expiresAt.After(now) {
		return Key{}, "", domain.Fail("INVALID_PUBLISHER_KEY", 400)
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return Key{}, "", err
	}
	token := "dsh_pub_" + hex.EncodeToString(raw[:])
	hash, _ := Hash(token)
	if expiresAt != nil {
		utc := expiresAt.UTC()
		expiresAt = &utc
	}
	return Key{ID: uuid.NewString(), Name: name, TokenHash: hash, Prefix: token[:16], Status: "active", CreatedAt: now, ExpiresAt: expiresAt}, token, nil
}
