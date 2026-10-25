package publisherauth

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestKeyIsRandomHashOnlyAndValidated(t *testing.T) {
	a, token, err := New(" office ", nil)
	if err != nil || a.Name != "office" || a.Prefix != token[:16] {
		t.Fatal("invalid key")
	}
	b, other, err := New("other", nil)
	if err != nil || a.ID == b.ID || token == other || a.TokenHash == b.TokenHash {
		t.Fatal("random credentials collided")
	}
	hash, ok := Hash(token)
	if !ok || hash != a.TokenHash {
		t.Fatal("digest mismatch")
	}
	raw, _ := json.Marshal(a)
	if strings.Contains(string(raw), a.TokenHash) || strings.Contains(string(raw), token) {
		t.Fatal("secret serialized")
	}
	for _, token := range []string{strings.Repeat("a", 64), "123456", "dsh_pub_" + strings.Repeat("G", 64)} {
		if _, ok := Hash(token); ok {
			t.Fatal("invalid or other credential type accepted")
		}
	}
	past := time.Now().Add(-time.Hour)
	for _, name := range []string{"", strings.Repeat("中", 101)} {
		if _, _, err := New(name, nil); err == nil {
			t.Fatal("invalid name accepted")
		}
	}
	if _, _, err := New("expired", &past); err == nil {
		t.Fatal("expired credential created")
	}
}
