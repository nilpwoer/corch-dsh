package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/packaccess"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type fakeManagement struct {
	active   bool
	accessMu sync.Mutex
	access   map[string]packaccess.View
}

func (f *fakeManagement) ReadRuntimeSettings(context.Context, *published.Entry) (store.SettingsView, error) {
	return store.SettingsView{}, nil
}
func (f *fakeManagement) SaveRuntimeSettings(context.Context, *published.Entry, int64, runtimecfg.Settings) (store.SettingsView, error) {
	return store.SettingsView{}, nil
}

func (f *fakeManagement) AuthenticateAccount(_ context.Context, user, password string) error {
	if user != "admin" || password != "synthetic-test-only" {
		return domain.Fail("INVALID_LOGIN", 401)
	}
	return nil
}
func (f *fakeManagement) NewAdminSession(context.Context, string) (string, error) {
	f.active = true
	return strings.Repeat("a", 64), nil
}
func (f *fakeManagement) AdminIdentity(_ context.Context, token string) (string, error) {
	if !f.active || token != strings.Repeat("a", 64) {
		return "", domain.Fail("ADMIN_SESSION_REQUIRED", 401)
	}
	return "admin", nil
}
func (f *fakeManagement) LogoutAdmin(context.Context, string) error { f.active = false; return nil }
func (f *fakeManagement) Reports(context.Context) ([]store.Task, error) {
	return []store.Task{{ID: "report-test", InterviewID: "interview-test", Kind: "report", Status: "succeeded", Output: []byte(`{"title":"报告"}`)}}, nil
}
func (f *fakeManagement) Get(_ context.Context, id string) (store.Task, error) {
	if id == "report-test" {
		return store.Task{ID: id, Kind: "report", Status: "succeeded"}, nil
	}
	return store.Task{ID: id, Kind: "followup"}, nil
}

func TestManagementAuthenticationUploadsAndReports(t *testing.T) {
	dir := t.TempDir()
	c := config.Portal{Origin: "https://portal.test", PacksDir: dir, SessionTTL: time.Hour, MaxPackBytes: 10000, LoginLimit: 20, LoginWindow: time.Minute}
	backend := &fakeManagement{}
	mux := http.NewServeMux()
	if err := mountManagement(mux, c, backend); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, origin, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://portal.test"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
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
	if w := call("GET", "/admin/api/packs", "", "", ""); w.Code != 401 {
		t.Fatalf("unauthenticated list: %d", w.Code)
	}
	if w := call("POST", "/admin/api/login", `{"username":"admin","password":"synthetic-test-only"}`, "https://attacker.test", ""); w.Code != 403 {
		t.Fatal("cross-origin login accepted")
	}
	login := call("POST", "/admin/api/login", `{"username":"admin","password":"synthetic-test-only"}`, c.Origin, "")
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].Path != "/admin" || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("invalid administrator cookie")
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value
	if w := call("GET", "/admin/api/packs", "", "", "teaching_preview="+cookies[0].Value); w.Code != 401 {
		t.Fatal("interview cookie granted administrator access")
	}
	pack := `{"fieldnoteId":"FN-test","questionPackMeta":{"version":1},"profile":{"name":"Test","industry":"Test","role":"Test","stage":"Test","experience":"Test"},"questions":[{"id":"Q01","title":"Task","type":"Open","question":"Describe a task"}]}`
	if w := call("POST", "/admin/api/packs/FN-test-v1", pack, c.Origin, cookie); w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	if w := call("POST", "/admin/api/packs/FN-test-v1", strings.Replace(pack, "Describe a task", "different", 1), c.Origin, cookie); w.Code != 400 {
		t.Fatal("different package overwrote existing publication")
	}
	if w := call("POST", "/admin/api/packs/broken", "{", c.Origin, cookie); w.Code != 400 {
		t.Fatal("partial upload published")
	}
	if _, err := os.Stat(filepath.Join(dir, "broken.json")); !os.IsNotExist(err) {
		t.Fatal("invalid file persisted")
	}
	if w := call("GET", "/admin/api/packs", "", "", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "FN-test-v1") {
		t.Fatal("uploaded publication undiscoverable")
	}
	if w := call("GET", "/admin/api/reports", "", "", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "report-test") {
		t.Fatal("reports unavailable")
	}
	if w := call("GET", "/admin/api/reports/not-report", "", "", cookie); w.Code != 404 {
		t.Fatal("followup accessible as report")
	}
	if w := call("GET", "/admin/api/missing", "", "", cookie); w.Code != 404 || strings.Contains(w.Body.String(), "<!doctype") {
		t.Fatal("API miss returned page")
	}
	if w := call("DELETE", "/admin/api/packs/FN-test-v1", "", "https://attacker.test", cookie); w.Code != 403 {
		t.Fatal("cross-origin deletion accepted")
	}
	if w := call("DELETE", "/admin/api/packs/FN-test-v1", "", c.Origin, cookie); w.Code != 200 {
		t.Fatal("deletion failed")
	}
	if w := call("POST", "/admin/api/logout", "", c.Origin, cookie); w.Code != 200 {
		t.Fatal("logout failed")
	}
	if w := call("GET", "/admin/api/reports", "", "", cookie); w.Code != 401 {
		t.Fatal("session survived logout")
	}
}
