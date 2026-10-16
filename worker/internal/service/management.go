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
	"github.com/fanzy531/corch-dsh/worker/internal/packaccess"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/publisherauth"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

//go:embed management.html
var managementPage []byte

//go:embed management.js
var managementScript []byte

//go:embed management.css
var managementStyle []byte

type managementBackend interface {
	CreatePublisherKey(context.Context, string, *time.Time) (publisherauth.Key, string, error)
	ListPublisherKeys(context.Context) ([]publisherauth.Key, error)
	RevokePublisherKey(context.Context, string) error
	AuthenticatePublisher(context.Context, string) error
	AuthenticateAccount(context.Context, string, string) error
	NewAdminSession(context.Context, string) (string, error)
	AdminIdentity(context.Context, string) (string, error)
	LogoutAdmin(context.Context, string) error
	Reports(context.Context) ([]store.Task, error)
	Get(context.Context, string) (store.Task, error)
	ReadRuntimeSettings(context.Context, *published.Entry) (store.SettingsView, error)
	SaveRuntimeSettings(context.Context, *published.Entry, int64, runtimecfg.Settings) (store.SettingsView, error)
	ReadPackAccess(context.Context, published.Entry) (packaccess.View, error)
	EnsurePackAccess(context.Context, published.Entry) (packaccess.View, error)
	ChangePackAccess(context.Context, published.Entry, int64, string) (packaccess.View, error)
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
			w.Header().Set("Cache-Control", "no-store")
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
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		_, _ = w.Write(managementPage)
	}
	mux.HandleFunc("GET /admin/{$}", page)
	for _, asset := range []struct {
		path, kind string
		body       []byte
	}{{"/admin/management.js", "text/javascript; charset=utf-8", managementScript}, {"/admin/management.css", "text/css; charset=utf-8", managementStyle}} {
		mux.HandleFunc("GET "+asset.path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", asset.kind)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			_, _ = w.Write(asset.body)
		})
	}
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
	mux.HandleFunc("GET /admin/api/publisher-keys", protect(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		keys, err := backend.ListPublisherKeys(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, map[string]any{"keys": keys})
	}, true))
	mux.HandleFunc("POST /admin/api/publisher-keys", protect(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		var input struct {
			Name      string     `json:"name"`
			ExpiresAt *time.Time `json:"expires_at"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		raw, err := io.ReadAll(r.Body)
		if err != nil || r.Header.Get("Content-Type") != "application/json" || domain.Decode(raw, &input) != nil {
			failure(w, domain.Fail("INVALID_PUBLISHER_KEY", 400))
			return
		}
		key, token, err := backend.CreatePublisherKey(r.Context(), input.Name, input.ExpiresAt)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 201, map[string]any{"key": key, "token": token})
	}, true))
	mux.HandleFunc("DELETE /admin/api/publisher-keys/{id}", protect(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := backend.RevokePublisherKey(r.Context(), r.PathValue("id")); err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, map[string]bool{"revoked": true})
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
	settingsHandler := func(pack bool, save bool) http.HandlerFunc {
		return protect(func(w http.ResponseWriter, r *http.Request) {
			var entry *published.Entry
			if pack {
				d, err := published.OpenDirectory(c.PacksDir, c.MaxPackBytes)
				if err != nil {
					failure(w, err)
					return
				}
				defer d.Close()
				value, err := d.Read(r.PathValue("key"))
				if err != nil {
					failure(w, domain.Fail("NOT_FOUND", 404))
					return
				}
				entry = &value
			}
			var view store.SettingsView
			var err error
			if save {
				var input struct {
					Revision        int64               `json:"revision"`
					Settings        runtimecfg.Settings `json:"settings"`
					PublicationHash string              `json:"publication_hash,omitempty"`
				}
				r.Body = http.MaxBytesReader(w, r.Body, 262144)
				raw, readErr := io.ReadAll(r.Body)
				if readErr != nil || r.Header.Get("Content-Type") != "application/json" || domain.Decode(raw, &input) != nil || input.Revision < 0 {
					failure(w, domain.Fail("INVALID_SETTINGS", 400))
					return
				}
				if entry != nil && input.PublicationHash != entry.Hash {
					failure(w, domain.Fail("SETTINGS_PUBLICATION_CHANGED", 409))
					return
				}
				view, err = backend.SaveRuntimeSettings(r.Context(), entry, input.Revision, input.Settings)
			} else {
				view, err = backend.ReadRuntimeSettings(r.Context(), entry)
			}
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, 200, view)
		}, true)
	}
	mux.HandleFunc("GET /admin/api/settings", settingsHandler(false, false))
	mux.HandleFunc("PUT /admin/api/settings", settingsHandler(false, true))
	mux.HandleFunc("GET /admin/api/packs/{key}/settings", settingsHandler(true, false))
	mux.HandleFunc("PUT /admin/api/packs/{key}/settings", settingsHandler(true, true))
	accessResponse := func(w http.ResponseWriter, entry published.Entry, view packaccess.View) {
		w.Header().Set("Cache-Control", "no-store")
		share := *u
		share.Path = "/"
		share.RawQuery = url.Values{"fieldnoteId": {entry.Key}}.Encode()
		if view.Status == "active" && view.Code != "" {
			share.Fragment = url.Values{"code": {view.Code}}.Encode()
		}
		respond(w, 200, map[string]any{"key": entry.Key, "access": view, "url": share.String()})
	}
	accessHandler := func(change bool) http.HandlerFunc {
		return protect(func(w http.ResponseWriter, r *http.Request) {
			withDirectory(w, r, func(d *published.Directory) {
				entry, err := d.Read(r.PathValue("key"))
				if err != nil {
					failure(w, domain.Fail("NOT_FOUND", 404))
					return
				}
				var view packaccess.View
				if c.InvitationMode != "code" {
					if change {
						failure(w, domain.Fail("ACCESS_NOT_REQUIRED", 409))
						return
					}
					accessResponse(w, entry, packaccess.View{Status: "not_required", Source: "worker", PublicationHash: entry.Hash})
					return
				}
				if change {
					var input struct {
						Action          string `json:"action"`
						Revision        int64  `json:"revision"`
						PublicationHash string `json:"publication_hash"`
					}
					r.Body = http.MaxBytesReader(w, r.Body, 4096)
					raw, readErr := io.ReadAll(r.Body)
					if readErr != nil || r.Header.Get("Content-Type") != "application/json" || domain.Decode(raw, &input) != nil || input.Revision < 0 {
						failure(w, domain.Fail("INVALID_ACCESS_REQUEST", 400))
						return
					}
					if input.PublicationHash != entry.Hash {
						failure(w, domain.Fail("ACCESS_PUBLICATION_CHANGED", 409))
						return
					}
					view, err = backend.ChangePackAccess(r.Context(), entry, input.Revision, input.Action)
				} else {
					view, err = backend.ReadPackAccess(r.Context(), entry)
				}
				if err != nil {
					failure(w, err)
					return
				}
				accessResponse(w, entry, view)
			})
		}, true)
	}
	mux.HandleFunc("GET /admin/api/packs/{key}/access", accessHandler(false))
	mux.HandleFunc("POST /admin/api/packs/{key}/access", accessHandler(true))
	publishPack := func(w http.ResponseWriter, r *http.Request) {
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
			var access packaccess.View
			if c.InvitationMode == "code" {
				access, err = backend.EnsurePackAccess(r.Context(), entry)
				if err != nil {
					failure(w, err)
					return
				}
			} else {
				access = packaccess.View{Status: "not_required", PublicationHash: entry.Hash, Source: "worker"}
			}
			w.Header().Set("Cache-Control", "no-store")
			share := *u
			share.Path = "/"
			share.RawQuery = url.Values{"fieldnoteId": {entry.Key}}.Encode()
			if access.Status == "active" && access.Code != "" {
				share.Fragment = url.Values{"code": {access.Code}}.Encode()
			}
			respond(w, 201, map[string]any{"key": entry.Key, "hash": entry.Hash, "access": access, "url": share.String()})
		})
	}
	mux.HandleFunc("POST /admin/api/packs/{key}", protect(publishPack, true))
	mux.HandleFunc("POST /publish/api/packs/{key}", publisherAuthorization(c, backend, publishPack))
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
	for _, format := range []string{"view", "pdf"} {
		mux.HandleFunc("GET /admin/api/reports/{id}/"+format, protect(func(w http.ResponseWriter, r *http.Request) {
			task, err := backend.Get(r.Context(), r.PathValue("id"))
			if err != nil {
				failure(w, err)
				return
			}
			serveSavedReport(w, r, task, format)
		}, true))
	}
	return nil
}
