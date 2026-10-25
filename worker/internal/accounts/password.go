// Package accounts protects administrator passwords; it never provisions plaintext defaults.
package accounts

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

// PBKDF2-HMAC-SHA256 uses the OWASP minimum work factor and a random per-password salt.
const iterations = 600000

func Hash(password string) (string, error) {
	if len(password) < 1 || len(password) > 1024 {
		return "", fmt.Errorf("invalid password length")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iterations, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
func parse(encoded string) (int, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return 0, nil, nil, fmt.Errorf("invalid password hash")
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil || n < iterations || n > 2000000 {
		return 0, nil, nil, fmt.Errorf("invalid password work factor")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil || len(salt) != 16 {
		return 0, nil, nil, fmt.Errorf("invalid password salt")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(key) != 32 {
		return 0, nil, nil, fmt.Errorf("invalid password key")
	}
	return n, salt, key, nil
}
func ValidHash(encoded string) bool { _, _, _, err := parse(encoded); return err == nil }
func Verify(encoded, password string) bool {
	n, salt, want, err := parse(encoded)
	if err != nil || len(password) < 1 || len(password) > 1024 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, n, 32)
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}
