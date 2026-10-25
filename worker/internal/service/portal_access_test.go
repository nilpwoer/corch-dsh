package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/packaccess"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type invitationPortalBackend struct {
	*fakeManagement
	checks   int
	sessions int
}

func (b *invitationPortalBackend) CheckPackAccess(ctx context.Context, entry published.Entry, code string) error {
	b.checks++
	return b.fakeManagement.CheckPackAccess(ctx, entry, code)
}
func (b *invitationPortalBackend) NewParticipantSession(_ context.Context, entry published.Entry) (string, store.ParticipantSession, error) {
	b.sessions++
	raw, err := json.Marshal(entry.Pack)
	return strings.Repeat("a", 64), store.ParticipantSession{InterviewID: "synthetic-interview", PackKey: entry.Key, PackHash: entry.Hash, PackData: raw}, err
}
func (*invitationPortalBackend) ParticipantIdentity(context.Context, string) (store.ParticipantSession, error) {
	return store.ParticipantSession{}, domain.Fail("INTERVIEW_SESSION_REQUIRED", 401)
}
func (*invitationPortalBackend) LogoutParticipant(context.Context, string) error { return nil }
func (*invitationPortalBackend) List(context.Context, string) ([]store.Task, error) {
	return nil, nil
}
func (*invitationPortalBackend) Enqueue(context.Context, string, domain.Submit) (store.Task, error) {
	return store.Task{}, domain.Fail("UNEXPECTED_TEST_MODEL_TASK", 500)
}

func invitationPortal(t *testing.T, limit int) (*http.ServeMux, *invitationPortalBackend) {
	t.Helper()
	assets, packs := t.TempDir(), t.TempDir()
	for name, body := range map[string]string{"practice-expert-interview-spa.html": "<script></script>", "practice-expert-worker.js": "void 0"} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	b := &invitationPortalBackend{fakeManagement: &fakeManagement{access: map[string]packaccess.View{}}}
	directory, err := published.OpenDirectory(packs, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	zero := 0
	for _, key := range []string{"digits-v1", "saved-long-v1", "legacy-v1"} {
		pack := published.Pack{FieldnoteID: key, PublicFieldnoteID: key, Goal: "synthetic goal", Profile: published.Profile{Name: "synthetic", Industry: "test", Role: "test", Stage: "test", Experience: "test"}, Questions: []published.Question{{ID: "Q01", Question: "synthetic question"}}, Meta: published.Meta{Version: 1}, Policy: &domain.FollowupPolicy{Scope: "per_question", MaxFollowups: &zero}}
		if key == "legacy-v1" {
			pack.Invitation = &published.Invitation{Code: "synthetic-legacy-long-invitation", Status: "active"}
		}
		raw, err := json.Marshal(pack)
		if err != nil {
			t.Fatal(err)
		}
		entry, err := directory.Publish(key, raw)
		if err != nil {
			t.Fatal(err)
		}
		if key != "legacy-v1" {
			code := "000007"
			if key == "saved-long-v1" {
				code = strings.Repeat("f", 40)
			}
			b.access[key] = packaccess.View{PublicationHash: entry.Hash, Revision: 1, Status: "active", Source: "worker", Code: code}
		}
	}
	mux := http.NewServeMux()
	c := config.Portal{Origin: "https://portal.test", AssetsDir: assets, PacksDir: packs, MaxPackBytes: 1 << 20, SessionTTL: time.Hour, InvitationMode: "code", EntryMode: "link", ParticipantReports: "deny", LoginLimit: limit, LoginWindow: time.Hour, PollInterval: time.Second}
	if err := mountPortal(mux, c, b, 1<<20, 1<<20); err != nil {
		t.Fatal(err)
	}
	return mux, b
}

func invitationAttempt(mux *http.ServeMux, key, code, address string) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(map[string]string{"key": key, "code": code})
	r := httptest.NewRequest("POST", "https://portal.test/portal/api/session", strings.NewReader(string(raw)))
	r.Header.Set("Origin", "https://portal.test")
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = address
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestPortalInvitationLeadingZerosAndExistingLongCodes(t *testing.T) {
	mux, b := invitationPortal(t, 20)
	for _, code := range []string{"7", "000008", " 000007", "000007 "} {
		if w := invitationAttempt(mux, "digits-v1", code, "192.0.2.1:1234"); w.Code != 401 || !strings.Contains(w.Body.String(), "INVALID_INVITATION") {
			t.Fatal("incorrect six-digit invitation accepted")
		}
	}
	for _, example := range []struct{ key, code string }{{"digits-v1", "000007"}, {"saved-long-v1", strings.Repeat("f", 40)}, {"legacy-v1", "synthetic-legacy-long-invitation"}} {
		w := invitationAttempt(mux, example.key, example.code, "192.0.2.1:1234")
		if w.Code != 200 || strings.Contains(w.Body.String(), example.code) {
			t.Fatalf("valid invitation rejected or exposed: status=%d", w.Code)
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || len(cookies[0].Value) != 64 || !cookies[0].HttpOnly {
			t.Fatal("participant session cookie contract changed")
		}
	}
	if b.sessions != 3 || b.access["digits-v1"].Code != "000007" || len(b.access["saved-long-v1"].Code) != 40 {
		t.Fatal("failed entry created a session or existing access was reset")
	}
	if _, migrated := b.access["legacy-v1"]; migrated {
		t.Fatal("entry automatically migrated legacy access")
	}
}

func TestPortalInvitationFailureLimitIsSharedAcrossPacksAndClients(t *testing.T) {
	mux, b := invitationPortal(t, 2)
	for i, key := range []string{"digits-v1", "saved-long-v1"} {
		address := []string{"192.0.2.1:1234", "198.51.100.2:4321"}[i]
		if w := invitationAttempt(mux, key, "wrong", address); w.Code != 401 {
			t.Fatal("incorrect invitation was not rejected")
		}
	}
	w := invitationAttempt(mux, "digits-v1", "000007", "203.0.113.3:3456")
	if w.Code != 429 || !strings.Contains(w.Body.String(), "LOGIN_RATE_LIMIT") || len(w.Result().Cookies()) != 0 || b.checks != 2 || b.sessions != 0 {
		t.Fatal("shared entry limit failed to reject further attempts before credential checks")
	}
	fresh, _ := invitationPortal(t, 2)
	if w := invitationAttempt(fresh, "digits-v1", "000007", "192.0.2.1:1234"); w.Code != 200 {
		t.Fatal("independent handler unexpectedly shares the in-memory attempt counter")
	}
}

func TestPortalInvitationSuccessfulRequestsAlsoConsumeTheLimit(t *testing.T) {
	mux, b := invitationPortal(t, 1)
	if w := invitationAttempt(mux, "digits-v1", "000007", "192.0.2.1:1234"); w.Code != 200 {
		t.Fatal("first valid invitation rejected")
	}
	w := invitationAttempt(mux, "digits-v1", "000007", "198.51.100.2:4321")
	if w.Code != 429 || !strings.Contains(w.Body.String(), "LOGIN_RATE_LIMIT") || b.checks != 1 || b.sessions != 1 {
		t.Fatal("successful requests did not consume the existing entry-attempt limit")
	}
}
