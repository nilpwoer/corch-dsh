package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/publisherauth"
)

func (f *fakeManagement) CreatePublisherKey(_ context.Context, name string, expires *time.Time) (publisherauth.Key, string, error) {
	k, token, err := publisherauth.New(name, expires)
	if err != nil {
		return k, "", err
	}
	f.keysMu.Lock()
	defer f.keysMu.Unlock()
	if f.keys == nil {
		f.keys = map[string]publisherauth.Key{}
	}
	f.keys[k.ID] = k
	return k, token, nil
}
func (f *fakeManagement) ListPublisherKeys(context.Context) ([]publisherauth.Key, error) {
	f.keysMu.Lock()
	defer f.keysMu.Unlock()
	result := []publisherauth.Key{}
	for _, k := range f.keys {
		k.TokenHash = ""
		result = append(result, k)
	}
	return result, nil
}
func (f *fakeManagement) RevokePublisherKey(_ context.Context, id string) error {
	f.keysMu.Lock()
	defer f.keysMu.Unlock()
	k, ok := f.keys[id]
	if !ok {
		return domain.Fail("NOT_FOUND", 404)
	}
	k.Status = "revoked"
	f.keys[id] = k
	return nil
}
func (f *fakeManagement) AuthenticatePublisher(_ context.Context, token string) error {
	hash, ok := publisherauth.Hash(token)
	f.keysMu.Lock()
	defer f.keysMu.Unlock()
	if ok {
		for id, k := range f.keys {
			if k.TokenHash == hash && k.Status == "active" && (k.ExpiresAt == nil || k.ExpiresAt.After(time.Now())) {
				now := time.Now().UTC()
				k.LastUsedAt = &now
				f.keys[id] = k
				return nil
			}
		}
	}
	return domain.Fail("PUBLISH_AUTH_INVALID", 401)
}

func TestPublisherKeyHTTPAuthenticationScopeAndLifecycle(t *testing.T) {
	c := config.Portal{Origin: "https://portal.test", PacksDir: t.TempDir(), MaxPackBytes: 10000, InvitationMode: "code", SessionTTL: time.Hour, LoginLimit: 20, LoginWindow: time.Minute}
	backend := &fakeManagement{}
	mux := http.NewServeMux()
	if err := mountManagement(mux, c, backend); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, token, origin, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, c.Origin+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := call("POST", "/admin/api/publisher-keys", `{"name":"desk"}`, "", c.Origin, ""); w.Code != 401 {
		t.Fatal("unauthorized key creation")
	}
	backend.active = true
	cookie := "teaching_admin=" + strings.Repeat("a", 64)
	if w := call("POST", "/admin/api/publisher-keys", `{"name":"desk"}`, "", "https://evil.test", cookie); w.Code != 403 {
		t.Fatal("cross-origin key creation")
	}
	w := call("POST", "/admin/api/publisher-keys", `{"name":"desk"}`, "", c.Origin, cookie)
	if w.Code != 201 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("creation: %d", w.Code)
	}
	var created struct {
		Key   publisherauth.Key `json:"key"`
		Token string            `json:"token"`
	}
	if json.Unmarshal(w.Body.Bytes(), &created) != nil || len(created.Token) != 72 {
		t.Fatal("invalid one-time credential")
	}
	if strings.Contains(w.Body.String(), "token_hash") {
		t.Fatal("digest leaked")
	}
	listed := call("GET", "/admin/api/publisher-keys", "", "", "", cookie)
	if listed.Code != 200 || strings.Contains(listed.Body.String(), created.Token) || strings.Contains(listed.Body.String(), "token_hash") {
		t.Fatal("plaintext reread or hash leak")
	}
	backend.active = false // publishing must work without any administrator session.
	pack := `{"fieldnoteId":"FN-key","questionPackMeta":{"version":1},"profile":{"name":"Test","industry":"Test","role":"Test","stage":"Test","experience":"Test"},"questions":[{"id":"Q01","title":"Task","type":"Open","question":"Describe a task"}]}`
	if w := call("POST", "/publish/api/packs/FN-key-v1", pack, "", "", ""); w.Code != 401 {
		t.Fatal("missing key accepted")
	}
	if w := call("POST", "/publish/api/packs/FN-key-v1", pack, created.Token, "https://evil.test", ""); w.Code != 403 {
		t.Fatal("cross-origin publishing accepted")
	}
	var receipt string
	for i := 0; i < 2; i++ {
		w := call("POST", "/publish/api/packs/FN-key-v1", pack, created.Token, "", "")
		if w.Code != 201 || strings.Contains(w.Body.String(), created.Token) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("key publish %d: %d", i, w.Code)
		}
		if i == 0 {
			receipt = w.Body.String()
		} else if receipt != w.Body.String() {
			t.Fatal("retry changed receipt")
		}
	}
	for _, path := range []string{"/admin/api/reports", "/admin/api/settings", "/admin/api/publisher-keys", "/admin/api/packs"} {
		if w := call("GET", path, "", created.Token, "", ""); w.Code != 401 {
			t.Fatal("publisher acquired admin access: " + path)
		}
	}
	if w := call("POST", "/admin/api/publisher-keys", `{"name":"escalation"}`, created.Token, c.Origin, ""); w.Code != 401 {
		t.Fatal("publisher created credentials")
	}
	backend.active = true
	if w := call("DELETE", "/admin/api/publisher-keys/"+created.Key.ID, "", "", c.Origin, cookie); w.Code != 200 {
		t.Fatal("revoke failed")
	}
	if w := call("POST", "/publish/api/packs/FN-key-v1", pack, created.Token, "", ""); w.Code != 401 {
		t.Fatal("revoked key accepted")
	}
	k, token, err := backend.CreatePublisherKey(context.Background(), "expired", nil)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute)
	k.ExpiresAt = &past
	backend.keys[k.ID] = k
	if w := call("POST", "/publish/api/packs/FN-key-v1", pack, token, "", ""); w.Code != 401 {
		t.Fatal("expired key accepted")
	}
}
