package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

type branch struct {
	Name, Origin, File, Binary string
	DB                         *sql.DB
	Proc                       *exec.Cmd
	Done                       chan error
	Mu                         sync.Mutex
}

func (b *branch) start() error {
	b.Proc = exec.Command(b.Binary, "serve", "-c", b.File)
	out, err := os.OpenFile(filepath.Join(filepath.Dir(b.File), "worker.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	b.Proc.Stdout = out
	b.Proc.Stderr = out
	b.Done = make(chan error, 1)
	if err = b.Proc.Start(); err != nil {
		out.Close()
		return err
	}
	proc, done := b.Proc, b.Done
	go func() { done <- proc.Wait(); out.Close() }()
	client := &http.Client{Timeout: time.Second}
	until := time.Now().Add(20 * time.Second)
	for time.Now().Before(until) {
		r, e := client.Get(b.Origin + "/health")
		if e == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("%s worker not ready; inspect owned worker.log", b.Name)
}
func (b *branch) stop() error {
	if b.Proc == nil {
		return nil
	}
	p := b.Proc
	b.Proc = nil
	if err := p.Process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	select {
	case <-b.Done:
		return nil
	case <-time.After(15 * time.Second):
		return fmt.Errorf("owned %s did not stop after SIGTERM; no forced termination", b.Name)
	}
}
func (b *branch) restart() error {
	b.Mu.Lock()
	defer b.Mu.Unlock()
	if err := b.stop(); err != nil {
		return err
	}
	return b.start()
}

const adminPassword = "synthetic-policy-browser-admin"
const quote = "负责方案审查，以验收记录确认质量。"

func main() {
	current := flag.String("worker", "", "Candidate Linux Worker")
	baseline := flag.String("baseline", "", "Baseline Linux Worker")
	mysqlFile := flag.String("mysql-config", "", "Task-only MySQL connection file")
	template := flag.String("config", "", "Public config template")
	assets := flag.String("assets", "", "Current public SPA assets")
	output := flag.String("out", "", "Fresh owned evidence directory; never removed")
	resume := flag.String("resume", "", "Existing owned fixture directory whose isolated databases are reused")
	currentListen := flag.String("current-listen", "", "Loopback address")
	baselineListen := flag.String("baseline-listen", "", "Loopback address")
	modelListen := flag.String("model-listen", "", "Loopback model/control address")
	flag.Parse()
	if *current == "" || *baseline == "" || *output == "" {
		log.Fatal("explicit fixture arguments required")
	}
	if _, e := os.Stat(*output); !os.IsNotExist(e) {
		log.Fatal("fresh output directory required")
	}
	if e := os.MkdirAll(*output, 0700); e != nil {
		log.Fatal(e)
	}
	raw, e := os.ReadFile(*mysqlFile)
	if e != nil {
		log.Fatal(e)
	}
	var supplied config.Config
	if e = yaml.Unmarshal(raw, &supplied); e != nil {
		log.Fatal(e)
	}
	dsn, e := driver.ParseDSN(supplied.Database.DSN)
	if e != nil {
		log.Fatal(e)
	}
	if !strings.HasPrefix(dsn.Addr, "127.0.0.1:") {
		log.Fatal("only task loopback SQL allowed")
	}
	dsn.DBName = ""
	admin, e := sql.Open("mysql", dsn.FormatDSN())
	if e != nil {
		log.Fatal(e)
	}
	defer admin.Close()
	var calls atomic.Int64
	var invalid atomic.Bool
	branches := map[string]*branch{}
	frozen := map[string]string{}
	var marks sync.Mutex
	finished := make(chan struct{})
	var finishOnce sync.Once
	var browserPassed atomic.Bool
	response := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/__state", func(w http.ResponseWriter, r *http.Request) {
		response(w, 200, map[string]any{"model_calls": calls.Load(), "paid_model_calls": 0})
	})
	mux.HandleFunc("/__control", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Action, Mode, Branch, InterviewID string
			Passed                            bool
		}
		if json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&in) != nil {
			response(w, 400, map[string]string{"error": "bad control"})
			return
		}
		switch in.Action {
		case "mode":
			invalid.Store(in.Mode == "invalid")
		case "restart":
			b := branches[in.Branch]
			if b == nil {
				response(w, 400, map[string]string{"error": "unknown branch"})
				return
			}
			if err := b.restart(); err != nil {
				response(w, 500, map[string]string{"error": err.Error()})
				return
			}
		case "mark":
			b := branches[in.Branch]
			if b == nil {
				response(w, 400, map[string]string{"error": "unknown branch"})
				return
			}
			if _, err := uuid.Parse(in.InterviewID); err != nil {
				response(w, 400, map[string]string{"error": "bad interview"})
				return
			}
			var hash string
			if err := b.DB.QueryRow("SELECT SHA2(CAST(contents AS CHAR),256) FROM tw_interview_runtime WHERE interview_id=?", in.InterviewID).Scan(&hash); err != nil {
				response(w, 500, map[string]string{"error": "mark failed"})
				return
			}
			marks.Lock()
			frozen[in.Branch+":"+in.InterviewID] = hash
			marks.Unlock()
		case "finish":
			browserPassed.Store(in.Passed)
			response(w, 200, map[string]bool{"ok": true})
			go func() { time.Sleep(150 * time.Millisecond); finishOnce.Do(func() { close(finished) }) }()
			return
		default:
			response(w, 400, map[string]string{"error": "unknown action"})
			return
		}
		response(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var in struct{ Messages []struct{ Content string } }
		if json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&in) != nil || len(in.Messages) == 0 {
			response(w, 400, map[string]string{"error": "synthetic model request"})
			return
		}
		system := in.Messages[0].Content
		var value any
		switch {
		case invalid.Load():
			value = map[string]any{"unexpected": true}
		case strings.Contains(system, "分析实践专家回答"):
			value = map[string]any{"status": "incomplete", "covered_slots": []string{}, "missing_slots": []string{}, "reason": "请提供合成记录实例"}
		case strings.Contains(system, "生成一条中性"):
			value = map[string]string{"text": "请补充一个合成任务中的具体实例。"}
		case strings.Contains(system, "提取证据"):
			value = map[string]any{"evidence": []any{map[string]string{"id": "e1", "question_id": "q_task", "quote": quote}}}
		default:
			value = map[string]any{"title": "合成访谈报告", "sections": []any{map[string]any{"title": "质量依据", "statements": []any{map[string]any{"kind": "fact", "text": "专家根据验收记录进行方案核对。", "evidence_ids": []string{"e1"}}}}}, "task_cards": []any{map[string]any{"title": "方案核对", "steps": []string{}, "judgments": []string{}, "tools": []string{}, "evidence_ids": []string{"e1"}}}, "needs_verification": []string{}}
		}
		encoded, _ := json.Marshal(value)
		response(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(encoded)}, "finish_reason": "stop"}}})
	})
	ln, e := net.Listen("tcp", *modelListen)
	if e != nil {
		log.Fatal(e)
	}
	modelOrigin := "http://" + ln.Addr().String()
	model := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go model.Serve(ln)
	defer model.Close()
	for _, spec := range []struct{ name, binary, listen string }{{"baseline", *baseline, *baselineListen}, {"current", *current, *currentListen}} {
		c, err := config.Load(*template)
		if err != nil {
			log.Fatal(err)
		}
		localDSN := *dsn
		if *resume != "" {
			c, err = config.Load(filepath.Join(*resume, spec.name, "config.yaml"))
			if err != nil {
				log.Fatal(err)
			}
			previous, err := driver.ParseDSN(c.Database.DSN)
			if err != nil || !strings.HasPrefix(previous.DBName, "tw_policy_browser_") || previous.Addr != dsn.Addr {
				log.Fatal("resume requires the same owned SQL fixture")
			}
			localDSN.DBName = previous.DBName
		} else {
			localDSN.DBName = "tw_policy_browser_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			if _, err = admin.Exec("CREATE DATABASE " + localDSN.DBName + " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
				log.Fatal(err)
			}
		}
		localDSN.ParseTime = true
		db, err := sql.Open("mysql", localDSN.FormatDSN())
		if err != nil {
			log.Fatal(err)
		}
		dir := filepath.Join(*output, spec.name)
		if err = os.MkdirAll(filepath.Join(dir, "packs"), 0700); err != nil {
			log.Fatal(err)
		}
		c.Database.DSN = localDSN.FormatDSN()
		c.Mode = "both"
		c.Auth.Token = "synthetic-policy-fixture-service-token-only"
		c.Server.Listen = spec.listen
		c.Server.MaxBodyBytes = 4 << 20
		hash, err := accounts.Hash(adminPassword)
		if err != nil {
			log.Fatal(err)
		}
		packs := filepath.Join(dir, "packs")
		if *resume != "" {
			packs = c.Portal.PacksDir
		}
		c.Portal = config.Portal{Enabled: true, AssetsDir: *assets, PacksDir: packs, Origin: "http://" + spec.listen, SessionTTL: time.Hour, MaxPackBytes: 2097152, AdminPasswordHash: hash, LoginLimit: 1000, LoginWindow: time.Minute, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", PollInterval: 30 * time.Millisecond, ModelLabel: "隔离合成模型"}
		provider := c.Providers["deepseek"]
		provider.BaseURL = modelOrigin
		provider.APIKey = "synthetic-no-paid-provider"
		c.Providers["deepseek"] = provider
		c.Queue.PollInterval = 20 * time.Millisecond
		c.Queue.MaxAttempts = 1
		cfg, err := yaml.Marshal(c)
		if err != nil {
			log.Fatal(err)
		}
		file := filepath.Join(dir, "config.yaml")
		if err = os.WriteFile(file, cfg, 0600); err != nil {
			log.Fatal(err)
		}
		b := &branch{Name: spec.name, Origin: c.Portal.Origin, File: file, Binary: spec.binary, DB: db}
		branches[spec.name] = b
		if err = b.start(); err != nil {
			log.Fatal(err)
		}
		defer b.stop()
		defer db.Close()
		pack := map[string]any{"schemaVersion": 1, "fieldnoteId": "FN-policy-baseline", "publicFieldnoteId": "FN-policy-baseline", "goal": "合成基线策略核对", "profile": map[string]string{"name": "合成专家", "role": "合成教师"}, "questionPackMeta": map[string]any{"version": 1}, "questions": []any{map[string]string{"id": "q_task", "title": "合成文本题", "type": "开放回答", "question": quote}}, "interviewPolicy": map[string]any{"scope": "per_question", "maxFollowups": 2}, "invitation": map[string]string{"code": "000000", "status": "active", "createdAt": "synthetic"}}
		bytes, _ := json.Marshal(pack)
		if *resume == "" {
			if err = os.WriteFile(filepath.Join(c.Portal.PacksDir, "FN-policy-baseline-v1.json"), bytes, 0600); err != nil {
				log.Fatal(err)
			}
		}
	}
	handoff := map[string]any{"origin": branches["current"].Origin, "baseline_origin": branches["baseline"].Origin, "control_origin": modelOrigin, "synthetic_password": adminPassword, "baseline_key": "FN-policy-baseline-v1", "paid_model_calls": 0}
	bytes, _ := json.MarshalIndent(handoff, "", "  ")
	if e = os.WriteFile(filepath.Join(*output, "handoff.json"), bytes, 0600); e != nil {
		log.Fatal(e)
	}
	fmt.Println("BROWSER_FIXTURE_READY")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-finished:
	case <-ctx.Done():
	case <-time.After(30 * time.Minute):
		fmt.Println("browser fixture timed out")
	}
	unchanged := true
	marks.Lock()
	frozenResults := map[string]bool{}
	for key, before := range frozen {
		parts := strings.SplitN(key, ":", 2)
		var after string
		err := branches[parts[0]].DB.QueryRow("SELECT SHA2(CAST(contents AS CHAR),256) FROM tw_interview_runtime WHERE interview_id=?", parts[1]).Scan(&after)
		equal := err == nil && after == before
		frozenResults[key] = equal
		unchanged = unchanged && equal
	}
	marks.Unlock()
	settings := map[string]any{}
	for name, b := range branches {
		rows, err := b.DB.Query("SELECT scope_key,revision,contents FROM tw_runtime_settings ORDER BY scope_key")
		if err != nil {
			log.Fatal(err)
		}
		var saved []any
		for rows.Next() {
			var key string
			var revision int64
			var raw []byte
			if rows.Scan(&key, &revision, &raw) != nil {
				log.Fatal("settings scan")
			}
			var value any
			_ = json.Unmarshal(raw, &value)
			saved = append(saved, map[string]any{"scope": key, "revision": revision, "settings": value})
		}
		rows.Close()
		settings[name] = saved
	}
	proof := map[string]any{"browser_passed": browserPassed.Load(), "frozen_records_unchanged": unchanged, "frozen_records": frozenResults, "settings_sql": settings, "synthetic_model_http_calls": calls.Load(), "paid_model_calls": 0, "files_deleted": false, "database_data_retained": true}
	bytes, _ = json.MarshalIndent(proof, "", "  ")
	if e = os.WriteFile(filepath.Join(*output, "sql-verification.json"), bytes, 0600); e != nil {
		log.Fatal(e)
	}
	if !browserPassed.Load() || !unchanged {
		fmt.Println("BROWSER_FIXTURE_FAILED")
		return
	}
	fmt.Println("BROWSER_FIXTURE_PASS")
}
