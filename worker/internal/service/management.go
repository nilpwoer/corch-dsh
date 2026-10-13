package service

import (
	"context"
	_ "embed"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

//go:embed management.html
var managementPage []byte

type managementBackend interface {
	AuthenticateAccount(context.Context, string, string) error
	NewAdminSession(context.Context, string) (string, error)
	AdminIdentity(context.Context, string) (string, error)
	LogoutAdmin(context.Context, string) error
	Reports(context.Context) ([]store.Task, error)
	Get(context.Context, string) (store.Task, error)
}

// mountManagement keeps administrator cookies and routes separate from interview sessions.
func mountManagement(mux *http.ServeMux, c config.Portal, backend managementBackend) error {
	directory, err := published.OpenDirectory(c.PacksDir, c.MaxPackBytes)
	if err != nil {
		return err
	}
	// Each request opens its own root handle; construction verifies configuration without leaking a handle.
	if err := directory.Close(); err != nil {
		return err
	}
	const cookieName = "teaching_admin"
	u, _ := url.Parse(c.Origin)
	secure := u.Scheme == "https"
	token := func(r *http.Request) string {
		cookie, err := r.Cookie(cookieName)
		if err != nil {
			return ""
		}
		return cookie.Value
	}
	protect := func(next http.HandlerFunc, requireSession bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Host != u.Host || r.Header.Get("Sec-Fetch-Site") == "cross-site" || (r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Origin") != c.Origin) {
				failure(w, domain.Fail("SAME_ORIGIN_REQUIRED", 403))
				return
			}
			if requireSession {
				if _, err := backend.AdminIdentity(r.Context(), token(r)); err != nil {
					failure(w, err)
					return
				}
			}
			next(w, r)
		}
	}
	page := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(managementPage)
	}
	mux.HandleFunc("GET /admin/{$}", page)
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/admin/", http.StatusSeeOther) })
	var loginMu sync.Mutex
	loginCount := 0
	windowStart := time.Now()
	mux.HandleFunc("POST /admin/api/login", protect(func(w http.ResponseWriter, r *http.Request) {
		loginMu.Lock()
		if time.Since(windowStart) >= c.LoginWindow {
			windowStart = time.Now()
			loginCount = 0
		}
		if loginCount >= c.LoginLimit {
			loginMu.Unlock()
			failure(w, domain.Fail("LOGIN_RATE_LIMIT", 429))
			return
		}
		loginCount++
		loginMu.Unlock()
		var input struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		raw, err := io.ReadAll(r.Body)
		if err != nil || domain.Decode(raw, &input) != nil || len(input.Username) > 100 || len(input.Password) > 1024 {
			failure(w, domain.Fail("INVALID_LOGIN", 401))
			return
		}
		if err := backend.AuthenticateAccount(r.Context(), input.Username, input.Password); err != nil {
			failure(w, err)
			return
		}
		session, err := backend.NewAdminSession(r.Context(), input.Username)
		if err != nil {
			failure(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: session, Path: "/admin", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: int(c.SessionTTL.Seconds()), Expires: time.Now().Add(c.SessionTTL)})
		respond(w, 200, map[string]string{"username": input.Username})
	}, false))
	mux.HandleFunc("GET /admin/api/session", protect(func(w http.ResponseWriter, r *http.Request) {
		username, err := backend.AdminIdentity(r.Context(), token(r))
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, map[string]string{"username": username})
	}, true))
	mux.HandleFunc("POST /admin/api/logout", protect(func(w http.ResponseWriter, r *http.Request) {
		if err := backend.LogoutAdmin(r.Context(), token(r)); err != nil {
			failure(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/admin", MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode})
		respond(w, 200, map[string]bool{"logged_out": true})
	}, true))
	withDirectory := func(w http.ResponseWriter, r *http.Request, run func(*published.Directory)) {
		d, err := published.OpenDirectory(c.PacksDir, c.MaxPackBytes)
		if err != nil {
			failure(w, err)
			return
		}
		defer d.Close()
		run(d)
	}
	mux.HandleFunc("GET /admin/api/packs", protect(func(w http.ResponseWriter, r *http.Request) {
		withDirectory(w, r, func(d *published.Directory) {
			entries, issues, err := d.Scan()
			if err != nil {
				failure(w, err)
				return
			}
			rows := []any{}
			for _, entry := range entries {
				rows = append(rows, map[string]any{"key": entry.Key, "fieldnoteId": entry.Pack.FieldnoteID, "packId": entry.Pack.Meta.PackID, "version": entry.Pack.Meta.Version, "hash": entry.Hash, "questions": len(entry.Pack.Questions)})
			}
			bad := []string{}
			for _, issue := range issues {
				bad = append(bad, issue.Key)
			}
			respond(w, 200, map[string]any{"packs": rows, "invalid_files": bad})
		})
	}, true))
	mux.HandleFunc("POST /admin/api/packs/{key}", protect(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			failure(w, domain.Fail("JSON_REQUIRED", 415))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, c.MaxPackBytes)
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			failure(w, domain.Fail("REQUEST_TOO_LARGE", 413))
			return
		}
		withDirectory(w, r, func(d *published.Directory) {
			entry, err := d.Publish(r.PathValue("key"), raw)
			if err != nil {
				failure(w, domain.Fail("PUBLICATION_REJECTED", 400))
				return
			}
			respond(w, 201, map[string]string{"key": entry.Key, "hash": entry.Hash})
		})
	}, true))
	mux.HandleFunc("DELETE /admin/api/packs/{key}", protect(func(w http.ResponseWriter, r *http.Request) {
		withDirectory(w, r, func(d *published.Directory) {
			if !published.ValidKey(r.PathValue("key")) {
				failure(w, domain.Fail("INVALID_PACK_KEY", 400))
				return
			}
			if err := d.Delete(r.PathValue("key")); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					failure(w, domain.Fail("NOT_FOUND", 404))
				} else {
					failure(w, err)
				}
				return
			}
			respond(w, 200, map[string]bool{"deleted": true})
		})
	}, true))
	mux.HandleFunc("GET /admin/api/reports", protect(func(w http.ResponseWriter, r *http.Request) {
		tasks, err := backend.Reports(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		rows := []any{}
		for _, task := range tasks {
			rows = append(rows, public(task))
		}
		respond(w, 200, rows)
	}, true))
	mux.HandleFunc("GET /admin/api/reports/{id}", protect(func(w http.ResponseWriter, r *http.Request) {
		task, err := backend.Get(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		if task.Kind != "report" {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		respond(w, 200, public(task))
	}, true))
	return nil
}
