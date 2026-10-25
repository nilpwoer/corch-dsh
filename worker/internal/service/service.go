// Package service 组合 HTTP 任务接口与独立后台消费者。
package service

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/engine"
	"github.com/fanzy531/corch-dsh/worker/internal/model"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	"github.com/google/uuid"
)

func Handler(s *store.Store) (http.Handler, error) {
	mux := http.NewServeMux()
	if s.Config.Portal.Enabled {
		if err := mountManagement(mux, s.Config.Portal, s); err != nil {
			return nil, err
		}
		if s.Config.Portal.ParticipantsEnabled {
			if err := mountPortal(mux, s.Config.Portal, s, s.Config.Server.MaxBodyBytes, s.Config.Queue.MaxInputBytes); err != nil {
				return nil, err
			}
		}
	}
	if s.Config.Preview.Enabled {
		if err := mountPreview(mux, s); err != nil {
			return nil, err
		}
	}
	expected := sha256.Sum256([]byte(s.Config.Auth.Token))
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			actual := sha256.Sum256([]byte(raw))
			if !ok || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
				respond(w, 401, map[string]string{"error_code": "UNAUTHORIZED"})
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		var value int
		err := s.DB.WithContext(r.Context()).Raw("SELECT 1").Scan(&value).Error
		if err != nil {
			respond(w, 503, map[string]string{"error_code": "DATABASE_UNAVAILABLE"})
			return
		}
		respond(w, 200, map[string]any{"ready": true, "mode": s.Config.Mode})
	})
	if s.Config.Mode == "worker" {
		return mux, nil
	}
	mux.HandleFunc("POST /v1/tasks", auth(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if len(key) < 1 || len(key) > 200 {
			failure(w, domain.Fail("IDEMPOTENCY_KEY_REQUIRED", 400))
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			failure(w, domain.Fail("JSON_REQUIRED", 415))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, s.Config.Server.MaxBodyBytes)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			failure(w, domain.Fail("REQUEST_TOO_LARGE", 413))
			return
		}
		var sub domain.Submit
		if err = domain.Decode(body, &sub); err != nil {
			failure(w, domain.Fail("INVALID_JSON", 400))
			return
		}
		if err = sub.Validate(); err != nil {
			failure(w, err)
			return
		}
		if len(body) > s.Config.Queue.MaxInputBytes {
			failure(w, domain.Fail("INPUT_TOO_LARGE", 413))
			return
		}
		task, err := s.Enqueue(r.Context(), key, sub)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 202, public(task))
	}))
	mux.HandleFunc("GET /v1/tasks/{id}", auth(func(w http.ResponseWriter, r *http.Request) {
		if _, err := uuid.Parse(r.PathValue("id")); err != nil {
			failure(w, domain.Fail("INVALID_TASK_ID", 400))
			return
		}
		task, err := s.Get(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, public(task))
	}))
	for _, format := range []string{"view", "pdf"} {
		mux.HandleFunc("GET /v1/tasks/{id}/"+format, auth(func(w http.ResponseWriter, r *http.Request) {
			if _, err := uuid.Parse(r.PathValue("id")); err != nil {
				failure(w, domain.Fail("INVALID_TASK_ID", 400))
				return
			}
			task, err := s.Get(r.Context(), r.PathValue("id"))
			if err != nil {
				failure(w, err)
				return
			}
			serveSavedReport(w, r, task, format)
		}))
	}
	mux.HandleFunc("GET /v1/interviews/{id}/tasks", auth(func(w http.ResponseWriter, r *http.Request) {
		tasks, err := s.List(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		result := []any{}
		for _, task := range tasks {
			result = append(result, public(task))
		}
		respond(w, 200, result)
	}))
	return mux, nil
}
func public(t store.Task) any {
	var release config.Release
	_ = json.Unmarshal(t.ReleaseData, &release)
	var input store.Input
	_ = json.Unmarshal(t.Input, &input)
	return struct {
		store.Task
		ReleaseVersion string              `json:"release_version"`
		ReleaseHash    string              `json:"release_hash"`
		InputVersion   int64               `json:"input_version"`
		QuestionID     string              `json:"question_id,omitempty"`
		Pack           *domain.PackContext `json:"pack,omitempty"`
	}{t, release.Pipeline.Version, release.Hash, input.Submit.Snapshot.InputVersion, input.Submit.QuestionID, input.Submit.Snapshot.Pack}
}
func failure(w http.ResponseWriter, err error) {
	var expected *domain.Error
	if errors.As(err, &expected) {
		respond(w, expected.HTTPStatus, map[string]string{"error_code": expected.Code})
		return
	}
	respond(w, 500, map[string]string{"error_code": "INTERNAL_ERROR"})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// Serve 配置决定只提供接口、只执行任务，或在同一进程中组合两者。
func Serve(ctx context.Context, c config.Config, log *slog.Logger) error {
	s, err := store.Open(ctx, c)
	if err != nil {
		return err
	}
	defer s.Close()
	handler, err := Handler(s)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", c.Server.Listen)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: c.Server.ReadTimeout, ReadTimeout: c.Server.ReadTimeout, WriteTimeout: c.Server.WriteTimeout, IdleTimeout: c.Server.ReadTimeout}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	if c.Mode != "api" {
		workers.Add(1)
		go func() {
			defer workers.Done()
			e := engine.Engine{Store: s, Model: &model.Client{Store: s, Config: c}, Log: log}
			e.Run(runCtx)
		}()
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	log.Info("teaching-worker ready", "listen", listener.Addr().String(), "mode", c.Mode)
	select {
	case <-ctx.Done():
	case err = <-result:
	}
	cancel()
	shutdown, stop := context.WithTimeout(context.Background(), c.Server.ShutdownTimeout)
	defer stop()
	if shutdownErr := server.Shutdown(shutdown); shutdownErr != nil {
		_ = server.Close()
		if err == nil {
			err = shutdownErr
		}
	}
	workers.Wait()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("服务停止: %w", err)
	}
	return nil
}
