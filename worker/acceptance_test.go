package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

const testToken = "go-worker-local-acceptance-token-only-123456"
const answerText = "负责方案审查，以验收记录确认质量。"

var mysqlConfigPath = flag.String("mysql-config", "", "MySQL 验收配置文件路径，仅用于读取 database.dsn")
var updateGolden = flag.Bool("update-golden", false, "更新模型消息及输出快照")
var suppliedWorkerBinary = flag.String("worker-binary", "", "Prebuilt Worker for isolated process acceptance when Go is unavailable")

func acceptanceBinary(t *testing.T, root string) string {
	t.Helper()
	if *suppliedWorkerBinary != "" {
		path, err := filepath.Abs(*suppliedWorkerBinary)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("prebuilt Worker must be an existing regular file")
		}
		return path
	}
	binary := filepath.Join(root, "teaching-worker")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	command := exec.Command("go", "build", "-o", binary, ".")
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	return binary
}

type capturedRequest struct {
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}
type fakeModel struct {
	mu              sync.Mutex
	requests        []capturedRequest
	holdNext        atomic.Bool
	held            chan struct{}
	release         chan struct{}
	failCompose     atomic.Int32
	invalidEvidence atomic.Bool
	invalidJSON     atomic.Bool
}

func (m *fakeModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req capturedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid fixture request", 400)
		return
	}
	m.mu.Lock()
	m.requests = append(m.requests, req)
	m.mu.Unlock()
	if m.holdNext.Swap(false) {
		close(m.held)
		select {
		case <-m.release:
		case <-r.Context().Done():
			return
		}
	}
	system := req.Messages[0].Content
	var output any
	switch {
	case strings.Contains(system, "分析实践专家回答"):
		var input struct {
			Question domain.Question `json:"question"`
		}
		_ = json.Unmarshal([]byte(req.Messages[1].Content), &input)
		missing := []string{}
		if len(input.Question.RequiredSlots) > 0 {
			missing = []string{"evidence"}
		}
		output = domain.Analysis{Status: "incomplete", CoveredSlots: []string{}, MissingSlots: missing, Reason: "需要质量记录的具体例子"}
	case strings.Contains(system, "生成一条中性"):
		if m.failCompose.Load() > 0 {
			m.failCompose.Add(-1)
			http.Error(w, "temporary outage", 503)
			return
		}
		output = map[string]string{"text": "能否举例说明验收记录如何支持质量判断？"}
	case strings.Contains(system, "提取证据"):
		quote := answerText
		if m.invalidEvidence.Load() {
			quote = "专家没有说过的内容"
		}
		output = domain.EvidenceResult{Evidence: []domain.Evidence{{ID: "e1", QuestionID: "q_task", Quote: quote}}}
	default:
		output = domain.Report{Title: "实践专家访谈报告", Sections: []domain.Section{{Title: "质量依据", Statements: []domain.Statement{{Kind: "fact", Text: "专家通过验收记录确认方案质量。", EvidenceIDs: []string{"e1"}}}}}, TaskCards: []domain.TaskCard{{Title: "方案审查", Steps: []string{}, Judgments: []string{}, Tools: []string{}, EvidenceIDs: []string{"e1"}}}, NeedsVerification: []string{}}
	}
	data, _ := json.Marshal(output)
	if m.invalidJSON.Load() {
		data = []byte(`{"unexpected":true}`)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(data)}, "finish_reason": "stop"}}})
}

type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(data)
}
func (b *safeBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buf.String() }

type process struct {
	cmd  *exec.Cmd
	done chan struct{}
	log  safeBuffer
	once sync.Once
}

func (p *process) stop() {
	if p == nil {
		return
	}
	p.once.Do(func() { _ = p.cmd.Process.Kill(); <-p.done })
}
func start(binary, file string) *process {
	p := &process{done: make(chan struct{})}
	p.cmd = exec.Command(binary, "serve", "-c", file)
	p.cmd.Stdout = &p.log
	p.cmd.Stderr = &p.log
	if err := p.cmd.Start(); err != nil {
		panic(err)
	}
	go func() { _ = p.cmd.Wait(); close(p.done) }()
	return p
}
func wait(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("acceptance condition timed out")
		}
		time.Sleep(30 * time.Millisecond)
	}
}
func port(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

// TestProcessAcceptance 运行真实 MySQL 和独立二进制进程，只替换外部模型 HTTP。
func TestProcessAcceptance(t *testing.T) {
	if *mysqlConfigPath == "" {
		t.Skip("run go test . -args -mysql-config config.local.yaml for real MySQL/process acceptance")
	}
	configData, err := os.ReadFile(*mysqlConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	var connectionConfig config.Config
	if err := yaml.Unmarshal(configData, &connectionConfig); err != nil {
		t.Fatal("invalid MySQL acceptance config")
	}
	raw := connectionConfig.Database.DSN
	dsn, err := driver.ParseDSN(raw)
	if err != nil {
		t.Fatal(err)
	}
	dsn.DBName = ""
	dsn.ParseTime = true
	admin, err := sql.Open("mysql", dsn.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	dbName := "tw_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec("CREATE DATABASE `" + dbName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec("DROP DATABASE `" + dbName + "`") }()
	dsn.DBName = dbName
	db, err := sql.Open("mysql", dsn.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	c, err := config.Load("config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	c.Database.DSN = dsn.FormatDSN()
	c.Auth.Token = testToken
	fake := &fakeModel{}
	modelServer := httptest.NewServer(fake)
	defer modelServer.Close()
	provider := c.Providers["deepseek"]
	provider.BaseURL = modelServer.URL
	provider.APIKey = "test-only-no-real-model"
	provider.RequestTimeout = 5 * time.Second
	c.Providers["deepseek"] = provider
	c.Queue.PollInterval = 40 * time.Millisecond
	c.Queue.LeaseDuration = 2 * time.Second
	c.Queue.HeartbeatInterval = 200 * time.Millisecond
	c.Queue.TaskTimeout = 10 * time.Second
	c.Queue.RetryDelay = 60 * time.Millisecond
	c.Queue.MaxRetryDelay = 200 * time.Millisecond
	c.Server.ShutdownTimeout = time.Second
	root := t.TempDir()
	binary := acceptanceBinary(t, root)
	var api, worker *process
	defer func() { api.stop(); worker.stop() }()
	writeConfig := func(mode string, cfg config.Config) string {
		cfg.Mode = mode
		file := filepath.Join(root, mode+".yaml")
		data, err := yaml.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		return file
	}
	launch := func(mode, address string) *process {
		cfg := c
		cfg.Server.Listen = address
		p := start(binary, writeConfig(mode, cfg))
		t.Cleanup(p.stop)
		client := &http.Client{Timeout: 300 * time.Millisecond}
		wait(t, func() bool {
			select {
			case <-p.done:
				t.Fatalf("%s exited: %s", mode, p.log.String())
			default:
			}
			res, err := client.Get("http://" + address + "/health")
			if err != nil {
				return false
			}
			defer res.Body.Close()
			return res.StatusCode == 200
		})
		return p
	}
	apiAddress := port(t)
	api = launch("api", apiAddress)
	worker = launch("worker", port(t))
	client := &http.Client{Timeout: 5 * time.Second}
	call := func(method, path, key string, value any, token string) (int, []byte) {
		var body io.Reader
		if value != nil {
			data, _ := json.Marshal(value)
			body = bytes.NewReader(data)
		}
		req, _ := http.NewRequest(method, "http://"+apiAddress+path, body)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Idempotency-Key", key)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	submit := func(in domain.Submit, key string) store.Task {
		status, data := call("POST", "/v1/tasks", key, in, testToken)
		if status != 202 {
			t.Fatalf("submit %d: %s", status, data)
		}
		var task store.Task
		if err := json.Unmarshal(data, &task); err != nil {
			t.Fatal(err)
		}
		return task
	}
	settled := func(id string) store.Task {
		var task store.Task
		wait(t, func() bool {
			status, data := call("GET", "/v1/tasks/"+id, "", nil, testToken)
			if status != 200 {
				t.Fatalf("get %d: %s", status, data)
			}
			_ = json.Unmarshal(data, &task)
			return task.Status == "succeeded" || task.Status == "failed" || task.Status == "superseded"
		})
		return task
	}
	input := func(id string) domain.Submit {
		data, err := os.ReadFile("examples/followup.json")
		if err != nil {
			t.Fatal(err)
		}
		var in domain.Submit
		if err = json.Unmarshal(data, &in); err != nil {
			t.Fatal(err)
		}
		in.Snapshot.InterviewID = id
		return in
	}
	expectSuccess := func(task store.Task) {
		if task.Status != "succeeded" {
			t.Fatalf("task failed: %+v", task)
		}
	}

	t.Run("assembled_followup_and_report_snapshot", func(t *testing.T) {
		in := input("snapshot_demo")
		if status, _ := call("POST", "/v1/tasks", "unauthorized", in, "wrong"); status != 401 {
			t.Fatal("unauthorized request admitted")
		}
		first := submit(in, "first")
		duplicate := submit(in, "first")
		if first.ID != duplicate.ID {
			t.Fatal("duplicate task")
		}
		if another := submit(in, "different-key-same-answer"); another.ID != first.ID {
			t.Fatal("same answer created duplicate follow-up")
		}
		changed := in
		changed.Snapshot.InputVersion++
		status, data := call("POST", "/v1/tasks", "first", changed, testToken)
		if status != 409 || !bytes.Contains(data, []byte("IDEMPOTENCY_CONFLICT")) {
			t.Fatalf("conflict: %s", data)
		}
		follow := settled(first.ID)
		expectSuccess(follow)
		in.Kind = "report"
		in.QuestionID = ""
		report := submit(in, "report")
		api.stop()
		api = nil
		wait(t, func() bool {
			var status string
			_ = db.QueryRow("SELECT status FROM tw_tasks WHERE id=?", report.ID).Scan(&status)
			return status == "succeeded"
		})
		api = launch("api", apiAddress)
		report = settled(report.ID)
		expectSuccess(report)
		status, data = call("POST", "/v1/tasks", "frozen", input("snapshot_demo"), testToken)
		if status != 409 || !bytes.Contains(data, []byte("INTERVIEW_FROZEN")) {
			t.Fatalf("freeze: %s", data)
		}
		fake.mu.Lock()
		requests := append([]capturedRequest(nil), fake.requests...)
		fake.mu.Unlock()
		snapshot := struct {
			Followup json.RawMessage   `json:"followup"`
			Report   json.RawMessage   `json:"report"`
			Requests []capturedRequest `json:"requests"`
		}{follow.Output, report.Output, requests}
		golden, err := json.MarshalIndent(snapshot, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		golden = append(golden, '\n')
		file := "testdata/flow.golden.json"
		if *updateGolden {
			if err = os.MkdirAll("testdata", 0755); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(file, golden, 0644); err != nil {
				t.Fatal(err)
			}
		}
		expected, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(expected, golden) {
			t.Fatalf("assembled snapshot changed; inspect output and update with -update-golden")
		}
	})
	t.Run("retry_resumes_completed_stage", func(t *testing.T) {
		fake.failCompose.Store(1)
		task := settled(submit(input("retry_demo"), "retry").ID)
		expectSuccess(task)
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM tw_calls WHERE task_id=? AND stage='analyze'", task.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 || task.Attempt != 2 {
			t.Fatalf("checkpoint reuse: calls=%d attempt=%d", count, task.Attempt)
		}
	})
	t.Run("modified_answers_supersede_pending_results", func(t *testing.T) {
		fake.held = make(chan struct{})
		fake.release = make(chan struct{})
		fake.holdNext.Store(true)
		in := input("stale_demo")
		old := submit(in, "stale-old")
		select {
		case <-fake.held:
		case <-time.After(5 * time.Second):
			t.Fatal("model not reached")
		}
		in.Snapshot.InputVersion = 2
		in.Snapshot.Answers[0].Text += "已补充说明。"
		newTask := submit(in, "stale-new")
		close(fake.release)
		if old = settled(old.ID); old.Status != "superseded" || string(old.Output) != "null" {
			t.Fatalf("stale output published: %+v", old)
		}
		expectSuccess(settled(newTask.ID))
	})
	t.Run("worker_process_crash_recovers_lease", func(t *testing.T) {
		fake.held = make(chan struct{})
		fake.release = make(chan struct{})
		fake.holdNext.Store(true)
		task := submit(input("restart_demo"), "restart")
		select {
		case <-fake.held:
		case <-time.After(5 * time.Second):
			t.Fatal("model not reached")
		}
		worker.stop()
		worker = nil
		close(fake.release)
		worker = launch("worker", port(t))
		task = settled(task.ID)
		expectSuccess(task)
		if task.Attempt < 2 {
			t.Fatal("task did not recover a new attempt")
		}
	})
	t.Run("skips_and_round_limits_do_not_call_models", func(t *testing.T) {
		in := input("skip_demo")
		in.Snapshot.Answers[0].Skipped = true
		in.Snapshot.Answers[0].Text = ""
		task := settled(submit(in, "skip").ID)
		expectSuccess(task)
		var count int
		_ = db.QueryRow("SELECT COUNT(*) FROM tw_calls WHERE task_id=?", task.ID).Scan(&count)
		if count != 0 {
			t.Fatal("skip called model")
		}
		in = input("limit_demo")
		for i := 1; i <= 3; i++ {
			in.Snapshot.InputVersion = int64(i)
			task = settled(submit(in, fmt.Sprintf("limit-%d", i)).ID)
			expectSuccess(task)
		}
		_ = db.QueryRow("SELECT COUNT(*) FROM tw_calls WHERE task_id=?", task.ID).Scan(&count)
		if count != 0 || !bytes.Contains(task.Output, []byte("FOLLOWUP_LIMIT")) {
			t.Fatalf("limit: %s calls=%d", task.Output, count)
		}
	})
	t.Run("invalid_model_json_is_terminal", func(t *testing.T) {
		fake.invalidJSON.Store(true)
		defer fake.invalidJSON.Store(false)
		task := settled(submit(input("json_demo"), "json").ID)
		if task.Status != "failed" || task.Attempt != 1 || task.ErrorCode == nil || *task.ErrorCode != "INVALID_MODEL_JSON" {
			t.Fatalf("invalid JSON: %+v", task)
		}
	})
	t.Run("invented_evidence_cannot_publish_report", func(t *testing.T) {
		fake.invalidEvidence.Store(true)
		defer fake.invalidEvidence.Store(false)
		in := input("evidence_demo")
		in.Kind = "report"
		in.QuestionID = ""
		task := settled(submit(in, "evidence").ID)
		if task.Status != "failed" || task.ErrorCode == nil || *task.ErrorCode != "INVALID_EVIDENCE" || string(task.Output) != "null" {
			t.Fatalf("evidence: %+v", task)
		}
	})
	t.Run("exhausted_transient_followup_requires_review", func(t *testing.T) {
		fake.failCompose.Store(3)
		task := settled(submit(input("review_demo"), "review").ID)
		expectSuccess(task)
		if task.Attempt != 3 || !bytes.Contains(task.Output, []byte("needs_review")) {
			t.Fatalf("fallback: %+v", task)
		}
	})
	t.Run("multiple_workers_do_not_duplicate_claims", func(t *testing.T) {
		second := launch("worker", port(t))
		defer second.stop()
		var tasks []store.Task
		for i := 0; i < 8; i++ {
			in := input(fmt.Sprintf("parallel_%d", i))
			in.Snapshot.Answers[0].Skipped = true
			tasks = append(tasks, submit(in, fmt.Sprintf("parallel-%d", i)))
		}
		for _, task := range tasks {
			result := settled(task.ID)
			expectSuccess(result)
			if result.Attempt != 1 {
				t.Fatal("task claimed more than once")
			}
		}
	})
	t.Run("expired_claim_cannot_overwrite_a_replacement", func(t *testing.T) {
		worker.stop()
		worker = nil
		in := input("claim_demo")
		in.Snapshot.Answers[0].Skipped = true
		task := submit(in, "claim")
		cfg := c
		cfg.Mode = "api"
		s, err := store.Open(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		old, err := s.Claim(context.Background(), "followup")
		if err != nil || old == nil || old.ID != task.ID {
			t.Fatalf("old claim %v: %+v", err, old)
		}
		if _, err = db.Exec("UPDATE tw_tasks SET lease_until=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?", task.ID); err != nil {
			t.Fatal(err)
		}
		fresh, err := s.Claim(context.Background(), "followup")
		if err != nil || fresh == nil {
			t.Fatalf("new claim: %v", err)
		}
		if err = s.Finish(context.Background(), *fresh, domain.FollowupResult{Status: "skipped", AllowSkip: true}); err != nil {
			t.Fatal(err)
		}
		if err = s.Finish(context.Background(), *old, domain.FollowupResult{Status: "complete"}); err == nil {
			t.Fatal("old claim overwrote result")
		}
		expectSuccess(settled(task.ID))
		worker = launch("worker", port(t))
	})
	t.Run("prompt_releases_and_report_regeneration", func(t *testing.T) {
		in := input("version_demo")
		expectSuccess(settled(submit(in, "version-initial").ID))
		in.Kind = "report"
		in.QuestionID = ""
		original := settled(submit(in, "version-report-1").ID)
		expectSuccess(original)
		api.stop()
		api = nil
		changed := c.Prompts["report"]
		changed.Compose += "\n调整报告措辞。"
		c.Prompts["report"] = changed
		cfg := c
		cfg.Server.Listen = apiAddress
		invalid := start(binary, writeConfig("api", cfg))
		defer invalid.stop()
		select {
		case <-invalid.done:
		case <-time.After(5 * time.Second):
			t.Fatal("mutated release did not fail startup")
		}
		if !strings.Contains(invalid.log.String(), "设置新的 version") {
			t.Fatalf("wrong startup failure: %s", invalid.log.String())
		}
		changed.Version = "report-v2"
		c.Prompts["report"] = changed
		api = launch("api", apiAddress)
		regenerated := settled(submit(in, "version-report-2").ID)
		expectSuccess(regenerated)
		if regenerated.ReportVersion != 2 {
			t.Fatal("report version did not advance")
		}
		status, data := call("GET", "/v1/tasks/"+regenerated.ID, "", nil, testToken)
		if status != 200 || !bytes.Contains(data, []byte(`"release_version":"report-v1"`)) {
			t.Fatalf("version: %s", data)
		}
		fresh := input("version_fresh_interview")
		fresh.Kind, fresh.QuestionID = "report", ""
		freshReport := settled(submit(fresh, "version-fresh-report").ID)
		expectSuccess(freshReport)
		status, data = call("GET", "/v1/tasks/"+freshReport.ID, "", nil, testToken)
		if status != 200 || !bytes.Contains(data, []byte(`"release_version":"report-v2"`)) {
			t.Fatalf("new interview did not use updated report release: %s", data)
		}
		if old := settled(original.ID); !bytes.Equal(old.Output, original.Output) {
			t.Fatal("prior report overwritten")
		}
	})
	t.Run("combined_mode_serves_and_consumes", func(t *testing.T) {
		worker.stop()
		worker = nil
		address := port(t)
		combined := launch("both", address)
		defer combined.stop()
		in := input("combined_demo")
		in.Snapshot.Answers[0].Skipped = true
		body, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest("POST", "http://"+address+"/v1/tasks", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "combined")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var task store.Task
		if res.StatusCode != 202 {
			t.Fatalf("combined submit: %d", res.StatusCode)
		}
		if err := json.NewDecoder(res.Body).Decode(&task); err != nil {
			t.Fatal(err)
		}
		expectSuccess(settled(task.ID))
	})
	t.Run("browser_session_flow_and_isolation", func(t *testing.T) {
		cfg := c
		cfg.Mode = "both"
		cfg.Server.Listen = port(t)
		cfg.Preview.Enabled = true
		cfg.Preview.AssetsDir = "../apps/web/public"
		cfg.Preview.PackFile = filepath.Join(root, "preview-pack.json")
		base := input("preview")
		pack := map[string]any{
			"fieldnoteId": "preview", "questionPackMeta": map[string]int{"version": 1}, "profile": base.Snapshot.Profile,
			"questions": []any{map[string]any{"id": "q_task", "title": "质量依据", "type": "开放回忆", "question": base.Snapshot.Questions[0].Text, "required_slots": []string{"evidence"}}},
		}
		packJSON, err := json.Marshal(pack)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(cfg.Preview.PackFile, packJSON, 0600); err != nil {
			t.Fatal(err)
		}
		p := start(binary, writeConfig("both", cfg))
		defer p.stop()
		baseURL := "http://" + cfg.Server.Listen
		wait(t, func() bool {
			response, err := client.Get(baseURL + "/health")
			if err != nil {
				return false
			}
			response.Body.Close()
			return response.StatusCode == 200
		})
		jarA, _ := cookiejar.New(nil)
		jarB, _ := cookiejar.New(nil)
		a := &http.Client{Jar: jarA, Timeout: 5 * time.Second}
		b := &http.Client{Jar: jarB, Timeout: 5 * time.Second}
		request := func(browser *http.Client, method, path, key, origin string, value any) (int, []byte) {
			var body io.Reader
			if value != nil {
				encoded, _ := json.Marshal(value)
				body = bytes.NewReader(encoded)
			}
			req, err := http.NewRequest(method, baseURL+path, body)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", key)
			if origin != "" {
				req.Header.Set("Origin", origin)
			}
			response, err := browser.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			data, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			return response.StatusCode, data
		}
		var session struct {
			InterviewID string `json:"interview_id"`
			Frozen      bool   `json:"frozen"`
		}
		status, data := request(a, "GET", "/browser/session", "", "", nil)
		if status != 200 || bytes.Contains(data, []byte(testToken)) {
			t.Fatalf("session: %d %s", status, data)
		}
		if err = json.Unmarshal(data, &session); err != nil {
			t.Fatal(err)
		}
		if session.InterviewID == "" {
			t.Fatal("missing browser identity")
		}
		request(b, "GET", "/browser/session", "", "", nil)
		base.Snapshot.InterviewID = session.InterviewID
		if status, _ := request(a, "POST", "/browser/tasks", "csrf", "http://other.example", base); status != 403 {
			t.Fatal("cross-origin mutation accepted")
		}
		if status, _ := request(a, "POST", "/browser/tasks", "csrf-empty", "", base); status != 403 {
			t.Fatal("origin-less browser mutation accepted")
		}
		other := base
		other.Snapshot.InterviewID = "another_interview"
		if status, _ := request(a, "POST", "/browser/tasks", "foreign", baseURL, other); status != 403 {
			t.Fatal("foreign interview submission accepted")
		}
		other = base
		other.Snapshot.QuestionPackVersion++
		if status, _ := request(a, "POST", "/browser/tasks", "changed-pack", baseURL, other); status != 409 {
			t.Fatal("changed question pack accepted")
		}
		status, data = request(a, "POST", "/browser/tasks", "followup", baseURL, base)
		if status != 202 {
			t.Fatalf("browser submit: %d %s", status, data)
		}
		var task store.Task
		if err = json.Unmarshal(data, &task); err != nil {
			t.Fatal(err)
		}
		if status, _ := request(b, "GET", "/browser/tasks/"+task.ID, "", "", nil); status != 404 {
			t.Fatal("another session read task")
		}
		wait(t, func() bool {
			status, data = request(a, "GET", "/browser/tasks/"+task.ID, "", "", nil)
			if status != 200 {
				t.Fatalf("browser get %d", status)
			}
			if err := json.Unmarshal(data, &task); err != nil {
				t.Fatal(err)
			}
			return task.Status == "succeeded" || task.Status == "failed"
		})
		expectSuccess(task)
		base.Kind = "report"
		base.QuestionID = ""
		status, data = request(a, "POST", "/browser/tasks", "report", baseURL, base)
		if status != 202 {
			t.Fatalf("browser report: %d %s", status, data)
		}
		if err = json.Unmarshal(data, &task); err != nil {
			t.Fatal(err)
		}
		expectSuccess(settled(task.ID))
		status, data = request(a, "GET", "/browser/session", "", "", nil)
		if status != 200 || !bytes.Contains(data, []byte(`"frozen":true`)) || !bytes.Contains(data, []byte(`"input_version":1`)) {
			t.Fatalf("restore: %s", data)
		}
		status, data = request(a, "POST", "/browser/session/reset", "", baseURL, map[string]any{})
		var reset struct {
			InterviewID string `json:"interview_id"`
		}
		if err = json.Unmarshal(data, &reset); err != nil {
			t.Fatal(err)
		}
		if status != 200 || reset.InterviewID == session.InterviewID {
			t.Fatal("new interview did not rotate session")
		}
		if status, _ := request(a, "GET", "/browser/tasks/"+task.ID, "", "", nil); status != 404 {
			t.Fatal("reset session retained old task access")
		}
	})
}
