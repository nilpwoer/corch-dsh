package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	"github.com/google/uuid"
)

type previewQuestion struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Type          string   `json:"type"`
	Question      string   `json:"question"`
	Helper        string   `json:"helper,omitempty"`
	Options       []string `json:"options,omitempty"`
	RequiredSlots []string `json:"required_slots"`
}
type previewPack struct {
	FieldnoteID string `json:"fieldnoteId"`
	Meta        struct {
		Version int64 `json:"version"`
	} `json:"questionPackMeta"`
	Profile   domain.Profile    `json:"profile"`
	Questions []previewQuestion `json:"questions"`
}

// mountPreview 限定本机、同源、会话所属访谈；共享 Worker 令牌不会进入页面。
func mountPreview(mux *http.ServeMux, s *store.Store) error {
	c := s.Config.Preview
	raw, err := os.ReadFile(c.PackFile)
	if err != nil {
		return fmt.Errorf("读取 preview.pack_file: %w", err)
	}
	var pack previewPack
	if err = domain.Decode(raw, &pack); err != nil {
		return fmt.Errorf("解析 preview.pack_file: %w", err)
	}
	snapshot := domain.Snapshot{InterviewID: "preview", InputVersion: 1, QuestionPackVersion: pack.Meta.Version, Profile: pack.Profile}
	for _, q := range pack.Questions {
		if len(q.RequiredSlots) == 0 {
			return fmt.Errorf("preview 题目 %s 缺少 required_slots", q.ID)
		}
		snapshot.Questions = append(snapshot.Questions, domain.Question{ID: q.ID, Text: q.Question, RequiredSlots: q.RequiredSlots})
		snapshot.Answers = append(snapshot.Answers, domain.Answer{QuestionID: q.ID, Skipped: true, Confirmed: true})
	}
	if err := (domain.Submit{Kind: "report", Snapshot: snapshot}).Validate(); err != nil {
		return fmt.Errorf("preview 问题包无效: %w", err)
	}
	for _, file := range []string{"practice-expert-interview-spa.html", "practice-expert-worker.js"} {
		path := filepath.Join(c.AssetsDir, file)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			return fmt.Errorf("preview 页面文件不存在: %s", path)
		}
		mux.HandleFunc("GET /"+file, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, path)
		})
	}
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/practice-expert-interview-spa.html?worker=1", http.StatusFound)
	})
	secret := s.Config.Auth.Token
	mac := func(value string) string {
		h := hmac.New(sha256.New, []byte(secret))
		_, _ = h.Write([]byte("preview:" + value))
		return hex.EncodeToString(h.Sum(nil))
	}
	const cookieName = "teaching_preview"
	identity := func(r *http.Request) string {
		cookie, err := r.Cookie(cookieName)
		if err != nil {
			return ""
		}
		parts := strings.Split(cookie.Value, ".")
		if len(parts) != 3 {
			return ""
		}
		if _, err := uuid.Parse(parts[0]); err != nil {
			return ""
		}
		expires, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || expires <= time.Now().Unix() || !hmac.Equal([]byte(parts[2]), []byte(mac(parts[0]+"."+parts[1]))) {
			return ""
		}
		return parts[0]
	}
	newIdentity := func(w http.ResponseWriter) string {
		id := uuid.NewString()
		expires := time.Now().Add(c.SessionTTL)
		value := id + "." + strconv.FormatInt(expires.Unix(), 10)
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value + "." + mac(value), Path: "/browser", HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: int(c.SessionTTL.Seconds())})
		return id
	}
	local := func(next http.HandlerFunc, requireSession bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			host, _, err := net.SplitHostPort(r.Host)
			if err != nil {
				host = r.Host
			}
			ip := net.ParseIP(host)
			remote, _, _ := net.SplitHostPort(r.RemoteAddr)
			remoteIP := net.ParseIP(remote)
			if (host != "localhost" && (ip == nil || !ip.IsLoopback())) || remoteIP == nil || !remoteIP.IsLoopback() {
				failure(w, domain.Fail("LOCAL_PREVIEW_ONLY", 403))
				return
			}
			origin := r.Header.Get("Origin")
			if (origin != "" && origin != "http://"+r.Host) || r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Method == "POST" && origin == "" {
				failure(w, domain.Fail("SAME_ORIGIN_REQUIRED", 403))
				return
			}
			if requireSession && identity(r) == "" {
				failure(w, domain.Fail("PREVIEW_SESSION_REQUIRED", 401))
				return
			}
			next(w, r)
		}
	}
	contextResponse := func(w http.ResponseWriter, r *http.Request, id string) {
		tasks, err := s.List(r.Context(), id)
		if err != nil {
			failure(w, err)
			return
		}
		copy := pack
		copy.FieldnoteID = id
		result := []any{}
		var latest *domain.Snapshot
		frozen := false
		for _, task := range tasks {
			result = append(result, public(task))
			var input store.Input
			if err := json.Unmarshal(task.Input, &input); err != nil {
				failure(w, domain.Fail("INVALID_TASK_DATA", 500))
				return
			}
			if latest == nil || input.Submit.Snapshot.InputVersion > latest.InputVersion {
				value := input.Submit.Snapshot
				latest = &value
			}
			frozen = frozen || task.Kind == "report"
		}
		respond(w, 200, map[string]any{"interview_id": id, "pack": copy, "tasks": result, "snapshot": latest, "frozen": frozen, "poll_interval_ms": c.PollInterval.Milliseconds(), "model_label": c.ModelLabel})
	}
	mux.HandleFunc("GET /browser/session", local(func(w http.ResponseWriter, r *http.Request) {
		id := identity(r)
		if id == "" {
			id = newIdentity(w)
		}
		contextResponse(w, r, id)
	}, false))
	mux.HandleFunc("POST /browser/session/reset", local(func(w http.ResponseWriter, r *http.Request) {
		contextResponse(w, r, newIdentity(w))
	}, true))
	mux.HandleFunc("POST /browser/tasks", local(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, s.Config.Server.MaxBodyBytes)
		raw, err := io.ReadAll(r.Body)
		if err != nil || len(raw) > s.Config.Queue.MaxInputBytes {
			failure(w, domain.Fail("REQUEST_TOO_LARGE", 413))
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			failure(w, domain.Fail("JSON_REQUIRED", 415))
			return
		}
		var input domain.Submit
		if err := domain.Decode(raw, &input); err != nil {
			failure(w, domain.Fail("INVALID_JSON", 400))
			return
		}
		if err := input.Validate(); err != nil {
			failure(w, err)
			return
		}
		if input.Snapshot.InterviewID != identity(r) {
			failure(w, domain.Fail("INTERVIEW_ACCESS_DENIED", 403))
			return
		}
		if config.Hash(input.Snapshot.Questions) != config.Hash(snapshot.Questions) || input.Snapshot.QuestionPackVersion != snapshot.QuestionPackVersion || input.Snapshot.Profile != snapshot.Profile {
			failure(w, domain.Fail("QUESTION_PACK_MISMATCH", 409))
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if len(key) < 1 || len(key) > 150 {
			failure(w, domain.Fail("IDEMPOTENCY_KEY_REQUIRED", 400))
			return
		}
		task, err := s.Enqueue(r.Context(), "preview:"+identity(r)+":"+key, input)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 202, public(task))
	}, true))
	mux.HandleFunc("GET /browser/tasks/{id}", local(func(w http.ResponseWriter, r *http.Request) {
		task, err := s.Get(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		if task.InterviewID != identity(r) {
			failure(w, domain.Fail("NOT_FOUND", 404))
			return
		}
		respond(w, 200, public(task))
	}, true))
	for _, format := range []string{"view", "pdf"} {
		mux.HandleFunc("GET /browser/tasks/{id}/"+format, local(func(w http.ResponseWriter, r *http.Request) {
			task, err := s.Get(r.Context(), r.PathValue("id"))
			if err != nil {
				failure(w, err)
				return
			}
			if task.InterviewID != identity(r) {
				failure(w, domain.Fail("NOT_FOUND", 404))
				return
			}
			serveSavedReport(w, r, task, format)
		}, true))
	}
	return nil
}
