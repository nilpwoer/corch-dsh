// Package packaccess owns participant invitation generation and validation, separate from admin credentials.
package packaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"io"
	"math/big"

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

// Generate uniformly samples a six-digit invitation, preserving leading zeros.
func Generate() (string, error) {
	return generate(rand.Reader, "")
}

// Rotate samples a new six-digit invitation that differs from the existing code.
func Rotate(previous string) (string, error) {
	return generate(rand.Reader, previous)
}

func generate(random io.Reader, previous string) (string, error) {
	for {
		value, err := rand.Int(random, big.NewInt(1_000_000))
		if err != nil {
			return "", err
		}
		code := fmt.Sprintf("%06d", value.Int64())
		if code != previous {
			return code, nil
		}
	}
}

// Check never returns the expected invitation or makes legacy fallback after revocation.
func Check(view View, code string) error {
	expected, actual := sha256.Sum256([]byte(view.Code)), sha256.Sum256([]byte(code))
	if view.Status != "active" || view.Code == "" || subtle.ConstantTimeCompare(expected[:], actual[:]) != 1 {
		return domain.Fail("INVALID_INVITATION", 401)
	}
	return nil
}
