package service

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type participantBackend interface {
	NewParticipantSession(context.Context, published.Entry) (string, store.ParticipantSession, error)
	ParticipantIdentity(context.Context, string) (store.ParticipantSession, error)
	LogoutParticipant(context.Context, string) error
	List(context.Context, string) ([]store.Task, error)
	Enqueue(context.Context, string, domain.Submit) (store.Task, error)
	Get(context.Context, string) (store.Task, error)
}

func participantOriginalEntry(row store.ParticipantSession) (published.Entry, error) {
	var p published.Pack
	if err := json.Unmarshal(row.PackData, &p); err != nil {
		return published.Entry{}, domain.Fail("INVALID_SESSION_DATA", 500)
	}
	return published.Entry{Key: row.PackKey, Pack: p, Hash: row.PackHash}, nil
}

func participantEntry(row store.ParticipantSession) (published.Entry, error) {
	entry, err := participantOriginalEntry(row)
	if err == nil && row.RuntimePolicy != nil {
		entry.Pack.Policy = row.RuntimePolicy
	}
	return entry, err
}

// mountPortal uses only explicitly configured participant policies, retaining the separate preview restriction.
func mountPortal(mux *http.ServeMux, c config.Portal, backend participantBackend, maxBodyBytes int64, maxInputBytes int) error {
	root, err := os.OpenRoot(c.AssetsDir)
	if err != nil {
		return err
	}
	defer root.Close()
	html, err := root.ReadFile("practice-expert-interview-spa.html")
	if err != nil {
		return err
	}
	bridge, err := root.ReadFile("practice-expert-worker.js")
	if err != nil {
		return err
	}
	// Select the existing worker entry without replacing the template or its styles.
	html = []byte(strings.Replace(string(html), "<script>", "<script>window.__TEACHING_PORTAL__=true;</script><script>", 1))
	page := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(html)
	}
	mux.HandleFunc("GET /{$}", page)
	mux.HandleFunc("GET /practice-expert-interview-spa.html", page)
	mux.HandleFunc("GET /practice-expert-worker.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(bridge)
	})
	u, _ := url.Parse(c.Origin)
	const cookieName = "teaching_interview"
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
				if _, err := backend.ParticipantIdentity(r.Context(), token(r)); err != nil {
					failure(w, err)
					return
				}
			}
			next(w, r)
		}
	}
	publicTask := func(task store.Task) any {
		if task.Kind == "report" && c.ParticipantReports == "deny" {
			task.Output = nil
		}
		return public(task)
	}
	contextResponse := func(w http.ResponseWriter, r *http.Request, row store.ParticipantSession) {
		entry, err := participantEntry(row)
		if err != nil {
			failure(w, err)
			return
		}
		fixed, err := entry.Snapshot(row.InterviewID)
		if err != nil {
			failure(w, err)
			return
		}
		tasks, err := backend.List(r.Context(), row.InterviewID)
		if err != nil {
			failure(w, err)
			return
		}
		var latest *domain.Snapshot
		frozen := false
		rows := []any{}
		for _, task := range tasks {
			rows = append(rows, publicTask(task))
			frozen = frozen || task.Kind == "report"
			var input store.Input
			if err := json.Unmarshal(task.Input, &input); err != nil {
				failure(w, domain.Fail("INVALID_TASK_DATA", 500))
				return
			}
			if latest == nil || input.Submit.Snapshot.InputVersion > latest.InputVersion {
				copy := input.Submit.Snapshot
				latest = &copy
			}
		}
		respond(w, 200, map[string]any{"interview_id": row.InterviewID, "pack": entry.Pack.ParticipantView(), "snapshot_template": fixed, "snapshot": latest, "tasks": rows, "frozen": frozen, "poll_interval_ms": c.PollInterval.Milliseconds(), "model_label": c.ModelLabel, "can_view_reports": c.ParticipantReports == "allow"})
	}
	findPack := func(key string) (published.Entry, error) {
		if key == "" || strings.ContainsAny(key, "/\\\x00") {
			return published.Entry{}, domain.Fail("PACK_ID_REQUIRED", 400)
		}
		d, err := published.OpenDirectory(c.PacksDir, c.MaxPackBytes)
		if err != nil {
			return published.Entry{}, err
		}
		defer d.Close()
		entries, _, err := d.Scan()
		if err != nil {
			return published.Entry{}, err
		}
		matches := []published.Entry{}
		for _, entry := range entries {
			if entry.Key == key || entry.Pack.PublicFieldnoteID == key || entry.Pack.FieldnoteID == key {
				matches = append(matches, entry)
			}
		}
		if len(matches) == 0 {
			return published.Entry{}, domain.Fail("NOT_FOUND", 404)
		}
		if len(matches) > 1 {
			return published.Entry{}, domain.Fail("PACK_VERSION_REQUIRED", 409)
		}
		return matches[0], nil
	}
	newSession := func(w http.ResponseWriter, r *http.Request, entry published.Entry) {
		value, row, err := backend.NewParticipantSession(r.Context(), entry)
		if err != nil {
			failure(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", HttpOnly: true, Secure: u.Scheme == "https", SameSite: http.SameSiteStrictMode, Expires: time.Now().Add(c.SessionTTL), MaxAge: int(c.SessionTTL.Seconds())})
		contextResponse(w, r, row)
	}
	mux.HandleFunc("GET /portal/api/packs", protect(func(w http.ResponseWriter, r *http.Request) {
		if c.EntryMode != "list" {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		d, err := published.OpenDirectory(c.PacksDir, c.MaxPackBytes)
		if err != nil {
			failure(w, err)
			return
		}
		defer d.Close()
		entries, _, err := d.Scan()
		if err != nil {
			failure(w, err)
			return
		}
		rows := []any{}
		for _, e := range entries {
			rows = append(rows, map[string]any{"key": e.Key, "fieldnoteId": e.Pack.FieldnoteID, "version": e.Pack.Meta.Version})
		}
		respond(w, 200, rows)
	}, false))
	mux.HandleFunc("GET /portal/api/session", protect(func(w http.ResponseWriter, r *http.Request) {
		row, err := backend.ParticipantIdentity(r.Context(), token(r))
		if err != nil {
			respond(w, 401, map[string]string{"error_code": "INTERVIEW_SESSION_REQUIRED", "invitation_mode": c.InvitationMode, "entry_mode": c.EntryMode})
			return
		}
		entry, err := participantEntry(row)
		if err != nil {
			failure(w, err)
			return
		}
		requested := r.URL.Query().Get("fieldnoteId")
		if requested != "" && requested != entry.Key && requested != entry.Pack.FieldnoteID && requested != entry.Pack.PublicFieldnoteID {
			respond(w, 409, map[string]string{"error_code": "QUESTION_PACK_MISMATCH", "invitation_mode": c.InvitationMode, "entry_mode": c.EntryMode})
			return
		}
		contextResponse(w, r, row)
	}, false))
	var attemptMu sync.Mutex
	attemptCount := 0
	attemptStart := time.Now()
	sessionAttempt := func() bool {
		attemptMu.Lock()
		defer attemptMu.Unlock()
		if time.Since(attemptStart) >= c.LoginWindow {
			attemptStart = time.Now()
			attemptCount = 0
		}
		if attemptCount >= c.LoginLimit {
			return false
		}
		attemptCount++
		return true
	}
	mux.HandleFunc("POST /portal/api/session", protect(func(w http.ResponseWriter, r *http.Request) {
		if !sessionAttempt() {
			failure(w, domain.Fail("LOGIN_RATE_LIMIT", 429))
			return
		}
		var input struct {
			Key  string `json:"key"`
			Code string `json:"code"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		raw, err := io.ReadAll(r.Body)
		if err != nil || domain.Decode(raw, &input) != nil {
			failure(w, domain.Fail("INVALID_JSON", 400))
			return
		}
		entry, err := findPack(input.Key)
		if err != nil {
			failure(w, err)
			return
		}
		if c.InvitationMode == "code" {
			invitation := entry.Pack.Invitation
			if invitation == nil || invitation.Status != "active" || invitation.Code == "" || subtle.ConstantTimeCompare([]byte(invitation.Code), []byte(input.Code)) != 1 {
				failure(w, domain.Fail("INVALID_INVITATION", 401))
				return
			}
		}
		newSession(w, r, entry)
	}, false))
	mux.HandleFunc("POST /portal/api/session/reset", protect(func(w http.ResponseWriter, r *http.Request) {
		row, err := backend.ParticipantIdentity(r.Context(), token(r))
		if err != nil {
			failure(w, err)
			return
		}
		entry, err := participantOriginalEntry(row)
		if err != nil {
			failure(w, err)
			return
		}
		newSession(w, r, entry)
	}, true))
	mux.HandleFunc("POST /portal/api/tasks", protect(func(w http.ResponseWriter, r *http.Request) {
		row, err := backend.ParticipantIdentity(r.Context(), token(r))
		if err != nil {
			failure(w, err)
			return
		}
		entry, err := participantEntry(row)
		if err != nil {
			failure(w, err)
			return
		}
		fixed, err := entry.Snapshot(row.InterviewID)
		if err != nil {
			failure(w, err)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		raw, err := io.ReadAll(r.Body)
		if err != nil || len(raw) > maxInputBytes {
			failure(w, domain.Fail("REQUEST_TOO_LARGE", 413))
			return
		}
		var input domain.Submit
		if r.Header.Get("Content-Type") != "application/json" || domain.Decode(raw, &input) != nil {
			failure(w, domain.Fail("INVALID_JSON", 400))
			return
		}
		if err := input.Validate(); err != nil {
			failure(w, err)
			return
		}
		if input.Snapshot.InterviewID != row.InterviewID || input.Snapshot.QuestionPackVersion != fixed.QuestionPackVersion || config.Hash(input.Snapshot.Pack) != config.Hash(fixed.Pack) || config.Hash(input.Snapshot.Questions) != config.Hash(fixed.Questions) || config.Hash(input.Snapshot.Profile) != config.Hash(fixed.Profile) {
			failure(w, domain.Fail("QUESTION_PACK_MISMATCH", 409))
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if len(key) < 1 || len(key) > 150 {
			failure(w, domain.Fail("IDEMPOTENCY_KEY_REQUIRED", 400))
			return
		}
		task, err := backend.Enqueue(r.Context(), "portal:"+row.InterviewID+":"+key, input)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 202, publicTask(task))
	}, true))
	mux.HandleFunc("GET /portal/api/tasks/{id}", protect(func(w http.ResponseWriter, r *http.Request) {
		row, err := backend.ParticipantIdentity(r.Context(), token(r))
		if err != nil {
			failure(w, err)
			return
		}
		task, err := backend.Get(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		if task.InterviewID != row.InterviewID {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		respond(w, 200, publicTask(task))
	}, true))
	mux.HandleFunc("GET /interviews/{id}", protect(func(w http.ResponseWriter, r *http.Request) {
		row, err := backend.ParticipantIdentity(r.Context(), token(r))
		if err != nil {
			failure(w, err)
			return
		}
		entry, err := participantEntry(row)
		if err != nil {
			failure(w, err)
			return
		}
		requested := r.PathValue("id")
		if !strings.HasSuffix(requested, ".json") || strings.ContainsAny(requested, "/\\\x00") {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		id := strings.TrimSuffix(requested, ".json")
		if id != entry.Key && id != entry.Pack.FieldnoteID && id != entry.Pack.PublicFieldnoteID {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		respond(w, 200, entry.Pack.ParticipantView())
	}, true))
	for _, format := range []string{"view", "pdf"} {
		mux.HandleFunc("GET /portal/api/tasks/{id}/"+format, protect(func(w http.ResponseWriter, r *http.Request) {
			row, err := backend.ParticipantIdentity(r.Context(), token(r))
			if err != nil {
				failure(w, err)
				return
			}
			task, err := backend.Get(r.Context(), r.PathValue("id"))
			if err != nil {
				failure(w, err)
				return
			}
			if task.InterviewID != row.InterviewID {
				failure(w, domain.Fail("NOT_FOUND", 404))
				return
			}
			if c.ParticipantReports != "allow" {
				failure(w, domain.Fail("REPORT_ACCESS_DENIED", 403))
				return
			}
			serveSavedReport(w, r, task, format)
		}, true))
	}
	return nil
}
