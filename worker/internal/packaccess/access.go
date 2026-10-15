// Package packaccess owns participant invitation generation and validation, separate from admin credentials.
package packaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
)

// View is secret management data; only authenticated admin responses may serialize it.
type View struct {
	Revision        int64  `json:"revision"`
	PublicationHash string `json:"publication_hash"`
	Status          string `json:"status"`
	Source          string `json:"source"`
	Code            string `json:"code,omitempty"`
}

// Legacy reads an existing invitation without creating, rotating or persisting credentials.
func Legacy(entry published.Entry) View {
	v := View{PublicationHash: entry.Hash, Status: "missing", Source: "worker"}
	if i := entry.Pack.Invitation; i != nil && i.Code != "" {
		v.Code = i.Code
		v.Status = i.Status
		v.Source = "legacy"
	}
	return v
}

// Generate uses 160 random bits; publication identity and process restarts do not determine a code.
func Generate() (string, error) {
	var raw [20]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

// Check never returns the expected invitation or makes legacy fallback after revocation.
func Check(view View, code string) error {
	expected, actual := sha256.Sum256([]byte(view.Code)), sha256.Sum256([]byte(code))
	if view.Status != "active" || view.Code == "" || subtle.ConstantTimeCompare(expected[:], actual[:]) != 1 {
		return domain.Fail("INVALID_INVITATION", 401)
	}
	return nil
}
