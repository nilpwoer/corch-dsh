package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

var publishSettingsHandoff = flag.String("publish-settings-handoff", "", "Private synthetic browser fixture for the publishing/settings acceptance")

// TestPublishSettingsAcceptance uses real HTTP/SQL/processes and only a controlled model endpoint.
func TestPublishSettingsAcceptance(t *testing.T) {
	if *mysqlConfigPath == "" {
		t.Skip("requires isolated MySQL acceptance config")
	}
	raw, err := os.ReadFile(*mysqlConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	var supplied config.Config
	if err := yaml.Unmarshal(raw, &supplied); err != nil {
		t.Fatal(err)
	}
	dsn, err := driver.ParseDSN(supplied.Database.DSN)
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
	name := "tw_publish_settings_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec("DROP DATABASE `" + name + "`") }()
	dsn.DBName = name
	db, err := sql.Open("mysql", dsn.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, file := range []string{"internal/store/schema.sql", "internal/store/portal-schema.sql"} {
		ddl, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, statement := range strings.Split(string(ddl), ";") {
			if strings.TrimSpace(statement) != "" {
				if _, err := db.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if _, err := db.Exec("INSERT INTO tw_schema(version) VALUES (2)"); err != nil {
		t.Fatal(err)
	}
	c, err := config.Load("config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	legacyRelease, _ := json.Marshal(c.Release("followup"))
	if _, err := db.Exec("INSERT INTO tw_interviews(id,input_version,input_hash,followup_release) VALUES ('legacy-sentinel',1,?,?)", strings.Repeat("a", 64), legacyRelease); err != nil {
		t.Fatal(err)
	}
	c.Database.DSN = dsn.FormatDSN()
	c.Mode = "both"
	c.Auth.Token = testToken
	c.Server.Listen = port(t)
	base := "http://" + c.Server.Listen
	hash, err := accounts.Hash("synthetic-publish-password")
	if err != nil {
		t.Fatal(err)
	}
	c.Portal = config.Portal{Enabled: true, AssetsDir: "../apps/web/public", PacksDir: t.TempDir(), Origin: base, SessionTTL: time.Hour, MaxPackBytes: 1048576, AdminPasswordHash: hash, LoginLimit: 200, LoginWindow: time.Minute, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", PollInterval: 40 * time.Millisecond, ModelLabel: "合成验收模型"}
	fixture := &fakeModel{}
	type requestMetadata struct {
		Model  string
		System string
	}
	var requests []requestMetadata
	var mu sync.Mutex
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var value struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.Unmarshal(body, &value) != nil || len(value.Messages) == 0 {
			http.Error(w, "synthetic request invalid", 400)
			return
		}
		mu.Lock()
		requests = append(requests, requestMetadata{value.Model, value.Messages[0].Content})
		mu.Unlock()
		r.Body = io.NopCloser(bytes.NewReader(body))
		fixture.ServeHTTP(w, r)
	}))
	defer model.Close()
	provider := c.Providers["deepseek"]
	provider.BaseURL = model.URL
	provider.APIKey = "synthetic-no-real-provider"
	c.Providers["deepseek"] = provider
	c.Queue.PollInterval = 30 * time.Millisecond
	root := t.TempDir()
	binary := acceptanceBinary(t, root)
	configuration := filepath.Join(root, "config.yaml")
	write := func() {
		raw, err := yaml.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(configuration, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	process := start(binary, configuration)
	defer func() { process.stop() }()
	ready := func() {
		wait(t, func() bool {
			select {
			case <-process.done:
				t.Fatalf("synthetic Worker exited: %s", process.log.String())
			default:
			}
			r, e := http.Get(base + "/health")
			if e != nil {
				return false
			}
			r.Body.Close()
			return r.StatusCode == 200
		})
	}
	ready()
	var schema int
	if err := db.QueryRow("SELECT version FROM tw_schema").Scan(&schema); err != nil || schema != 5 {
		t.Fatal("additive version 2 migration failed")
	}
	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar, Timeout: 10 * time.Second}
	}
	manager, owner, newOwner, anonymous := newClient(), newClient(), newClient(), newClient()
	request := func(client *http.Client, method, path, key string, value any) (int, []byte) {
		var reader io.Reader
		if value != nil {
			body, _ := json.Marshal(value)
			reader = bytes.NewReader(body)
		}
		r, _ := http.NewRequest(method, base+path, reader)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", base)
		r.Header.Set("Idempotency-Key", key)
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, body
	}
	for _, path := range []string{"/admin/api/settings", "/admin/api/packs/FN-settings-v1/settings"} {
		if code, _ := request(anonymous, "GET", path, "", nil); code != 401 {
			t.Fatal("unauthenticated settings access")
		}
	}
	if code, _ := request(manager, "POST", "/admin/api/login", "", map[string]string{"username": "admin", "password": "synthetic-publish-password"}); code != 200 {
		t.Fatal("synthetic login failed")
	}
	pack := map[string]any{"schemaVersion": 1, "fieldnoteId": "FN-settings", "publicFieldnoteId": "FN-settings", "goal": "核实任务证据", "profile": domain.Profile{Name: "合成专家", Role: "合成教师"}, "questionPackMeta": map[string]any{"packId": "synthetic-settings", "version": 1}, "questions": []any{map[string]any{"id": "q_task", "title": "课堂核对", "type": "开放回答", "question": "描述任务核对过程"}}, "interviewPolicy": map[string]any{"scope": "per_question", "maxFollowups": 2}, "invitation": map[string]any{"code": "000000", "status": "active", "createdAt": "synthetic"}, "publishedAt": "2026-10-14T00:00:00Z"}
	const packPath = "/admin/api/packs/FN-settings-v1"
	if code, _ := request(manager, "POST", packPath, "", pack); code != 201 {
		t.Fatal("initial synthetic upload failed")
	}
	read := func(path string) store.SettingsView {
		code, body := request(manager, "GET", path, "", nil)
		var value store.SettingsView
		if code != 200 || json.Unmarshal(body, &value) != nil {
			t.Fatalf("settings read: %d", code)
		}
		if bytes.Contains(body, []byte("api_key")) || bytes.Contains(body, []byte(testToken)) {
			t.Fatal("settings leaked credentials")
		}
		return value
	}
	save := func(path string, value store.SettingsView, settings runtimecfg.Settings) store.SettingsView {
		code, body := request(manager, "PUT", path, "", map[string]any{"revision": value.Revision, "publication_hash": value.PublicationHash, "settings": settings})
		var next store.SettingsView
		if code != 200 || json.Unmarshal(body, &next) != nil {
			t.Fatalf("settings save: %d %s", code, body)
		}
		return next
	}
	prompts := func(kind, marker string) *runtimecfg.Prompts {
		p := c.Prompts[kind]
		return &runtimecfg.Prompts{Analyze: p.Analyze + "\n" + marker + "_ANALYZE", Compose: p.Compose + "\n" + marker + "_COMPOSE"}
	}
	globalPath := "/admin/api/settings"
	settingsPath := packPath + "/settings"
	global := save(globalPath, read(globalPath), runtimecfg.Settings{Followup: prompts("followup", "GLOBAL_V1"), Report: prompts("report", "GLOBAL_V1")})
	limit := 2
	perPack := save(settingsPath, read(settingsPath), runtimecfg.Settings{Followup: prompts("followup", "PACK_V1"), Policy: &domain.FollowupPolicy{Scope: "per_question", MaxFollowups: &limit}})
	if !strings.Contains(perPack.Effective["followup"].Analyze, "PACK_V1") || !strings.Contains(perPack.Effective["report"].Analyze, "GLOBAL_V1") {
		t.Fatal("global/package inheritance failed")
	}
	if code, _ := request(manager, "PUT", globalPath, "", map[string]any{"revision": global.Revision, "settings": map[string]any{"report": map[string]any{"analyze": "text", "compose": "text", "model": map[string]string{"name": "unauthorized"}}}}); code != 400 {
		t.Fatal("model configuration accepted through business prompt API")
	}
	enter := func(client *http.Client, key string) domain.Snapshot {
		code, body := request(client, "POST", "/portal/api/session", "", map[string]string{"key": key, "code": "000000"})
		var value struct {
			Snapshot domain.Snapshot `json:"snapshot_template"`
		}
		if code != 200 || json.Unmarshal(body, &value) != nil {
			t.Fatalf("enter synthetic session: %d %s", code, body)
		}
		text := answerText
		value.Snapshot.Answers = []domain.Answer{{QuestionID: "q_task", Text: answerText, TextInput: &text, Confirmed: true}}
		return value.Snapshot
	}
	oldSnapshot := enter(owner, "FN-settings-v1")
	var frozenBefore string
	if err := db.QueryRow("SELECT SHA2(CAST(contents AS CHAR),256) FROM tw_interview_runtime WHERE interview_id=?", oldSnapshot.InterviewID).Scan(&frozenBefore); err != nil {
		t.Fatal(err)
	}
	global = save(globalPath, global, runtimecfg.Settings{Followup: prompts("followup", "GLOBAL_V2"), Report: prompts("report", "GLOBAL_V2")})
	zero := 0
	stale := perPack
	perPack = save(settingsPath, perPack, runtimecfg.Settings{Policy: &domain.FollowupPolicy{Scope: "interview", MaxFollowups: &zero}})
	readBack := read(settingsPath)
	if readBack.Revision != perPack.Revision || readBack.PolicySource != "override" || readBack.Settings.Policy == nil || *readBack.Settings.Policy.MaxFollowups != 0 || readBack.Policy.Scope != "interview" {
		t.Fatal("saved package policy did not survive a fresh GET")
	}
	var savedPolicy []byte
	var savedRevision int64
	if err := db.QueryRow("SELECT contents,revision FROM tw_runtime_settings WHERE scope_key=?", "pack:FN-settings-v1").Scan(&savedPolicy, &savedRevision); err != nil {
		t.Fatal(err)
	}
	var persisted runtimecfg.Settings
	if json.Unmarshal(savedPolicy, &persisted) != nil || persisted.Policy == nil || *persisted.Policy.MaxFollowups != 0 || persisted.Policy.Scope != "interview" || savedRevision != perPack.Revision {
		t.Fatal("policy PUT did not commit the expected SQL record")
	}
	tooMany := 3
	if code, _ := request(manager, "PUT", settingsPath, "", map[string]any{"revision": perPack.Revision, "publication_hash": perPack.PublicationHash, "settings": runtimecfg.Settings{Policy: &domain.FollowupPolicy{Scope: "per_question", MaxFollowups: &tooMany}}}); code != 400 {
		t.Fatal("editable ceiling above two was accepted")
	}
	if code, _ := request(manager, "PUT", settingsPath, "", map[string]any{"revision": stale.Revision, "publication_hash": stale.PublicationHash, "settings": stale.Settings}); code != 409 {
		t.Fatal("stale settings overwrote newer revision")
	}
	if code, _ := request(manager, "POST", packPath, "", pack); code != 201 {
		t.Fatal("identical publication retry failed")
	}
	if read(settingsPath).Revision != perPack.Revision {
		t.Fatal("republication reset Worker settings")
	}
	newSnapshot := enter(newOwner, "FN-settings-v1")
	if newSnapshot.Pack.Policy.Scope != "interview" || *newSnapshot.Pack.Policy.MaxFollowups != 0 {
		t.Fatal("new session did not adopt current package policy")
	}
	var frozenAfter string
	if err := db.QueryRow("SELECT SHA2(CAST(contents AS CHAR),256) FROM tw_interview_runtime WHERE interview_id=?", oldSnapshot.InterviewID).Scan(&frozenAfter); err != nil || frozenAfter != frozenBefore {
		t.Fatal("admin edit changed started interview")
	}
	oldModel := c.Prompts["report"].Model.Name
	oldAttempts := c.Queue.MaxAttempts
	process.stop()
	for _, kind := range []string{"followup", "report"} {
		pipeline := c.Prompts[kind]
		pipeline.Version += "-next"
		pipeline.Model.Name = "synthetic-next-model"
		c.Prompts[kind] = pipeline
	}
	c.Queue.MaxAttempts++
	write()
	process = start(binary, configuration)
	ready()
	afterRestart := read(settingsPath)
	if afterRestart.Revision != perPack.Revision || afterRestart.Settings.Policy == nil || *afterRestart.Settings.Policy.MaxFollowups != 0 || afterRestart.Policy.Scope != "interview" {
		t.Fatal("saved policy changed after Worker restart")
	}
	submit := func(client *http.Client, kind, key string, snapshot domain.Snapshot) store.Task {
		value := domain.Submit{Kind: kind, Snapshot: snapshot}
		if kind == "followup" {
			value.QuestionID = "q_task"
		}
		code, body := request(client, "POST", "/portal/api/tasks", key, value)
		var task store.Task
		if code != 202 || json.Unmarshal(body, &task) != nil {
			t.Fatalf("enqueue %s: %d %s", kind, code, body)
		}
		wait(t, func() bool {
			code, body = request(client, "GET", "/portal/api/tasks/"+task.ID, "", nil)
			if code != 200 {
				return false
			}
			_ = json.Unmarshal(body, &task)
			return task.Status == "succeeded" || task.Status == "failed"
		})
		if task.Status != "succeeded" {
			t.Fatalf("synthetic task failed: %v", task.ErrorCode)
		}
		return task
	}
	oldFollowup := submit(owner, "followup", "old-followup", oldSnapshot)
	oldReport := submit(owner, "report", "old-report", oldSnapshot)
	for _, task := range []store.Task{oldFollowup, oldReport} {
		var releaseRaw, optionsRaw []byte
		if err := db.QueryRow("SELECT release_data,options FROM tw_tasks WHERE id=?", task.ID).Scan(&releaseRaw, &optionsRaw); err != nil {
			t.Fatal(err)
		}
		var release config.Release
		var options config.Queue
		if json.Unmarshal(releaseRaw, &release) != nil || json.Unmarshal(optionsRaw, &options) != nil || release.Pipeline.Model.Name != oldModel || options.MaxAttempts != oldAttempts {
			t.Fatal("execution used live instead of frozen model/options")
		}
		marker := "GLOBAL_V1"
		if task.Kind == "followup" {
			marker = "PACK_V1"
		}
		if !strings.Contains(release.Pipeline.Analyze, marker) {
			t.Fatal("execution lost frozen business prompts")
		}
	}
	mu.Lock()
	captured := append([]requestMetadata(nil), requests...)
	mu.Unlock()
	if len(captured) != 4 {
		t.Fatalf("controlled model calls: %d", len(captured))
	}
	for _, value := range captured {
		if value.Model != oldModel {
			t.Fatal("actual model HTTP request ignored frozen model")
		}
	}
	before := len(captured)
	submit(newOwner, "followup", "zero-policy", newSnapshot)
	mu.Lock()
	after := len(requests)
	mu.Unlock()
	if after != before {
		t.Fatal("zero package policy called a model")
	}
	thirdSnapshot := enter(newClient(), "FN-settings-v1")
	var frozenRaw []byte
	if err := db.QueryRow("SELECT contents FROM tw_interview_runtime WHERE interview_id=?", thirdSnapshot.InterviewID).Scan(&frozenRaw); err != nil {
		t.Fatal(err)
	}
	var frozen runtimecfg.Frozen
	if json.Unmarshal(frozenRaw, &frozen) != nil || !frozen.Valid() || frozen.Report.Pipeline.Model.Name != "synthetic-next-model" || !strings.Contains(frozen.Report.Pipeline.Analyze, "GLOBAL_V2") {
		t.Fatal("new interview did not freeze updated defaults")
	}
	code, pdf := request(manager, "GET", "/admin/api/reports/"+oldReport.ID+"/pdf", "", nil)
	if code != 200 || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatal("saved PDF regression")
	}
	var sentinel string
	if err := db.QueryRow("SELECT input_hash FROM tw_interviews WHERE id='legacy-sentinel'").Scan(&sentinel); err != nil || sentinel != strings.Repeat("a", 64) {
		t.Fatal("migration changed legacy history")
	}
	packBytes, err := os.ReadFile(filepath.Join(c.Portal.PacksDir, "FN-settings-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	packDigest := sha256.Sum256(packBytes)
	if *publishSettingsHandoff != "" {
		fixture, _ := json.Marshal(map[string]any{"origin": base, "report_id": oldReport.ID, "pack_key": "FN-settings-v1", "pack_sha256": hex.EncodeToString(packDigest[:]), "synthetic_password": "synthetic-publish-password"})
		if err := os.WriteFile(*publishSettingsHandoff, fixture, 0600); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(240 * time.Second)
		for {
			result, err := os.ReadFile(*publishSettingsHandoff + ".done")
			if err == nil {
				if strings.TrimSpace(string(result)) != "PASS" {
					t.Fatal("publishing browser verification failed")
				}
				break
			}
			if !os.IsNotExist(err) || time.Now().After(deadline) {
				t.Fatal("publishing browser handoff timed out")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	legacyPack := make(map[string]any, len(pack))
	for key, value := range pack {
		legacyPack[key] = value
	}
	delete(legacyPack, "interviewPolicy")
	legacyPack["fieldnoteId"], legacyPack["publicFieldnoteId"] = "FN-legacy-policy", "FN-legacy-policy"
	const legacyPath = "/admin/api/packs/FN-legacy-policy-v1"
	if code, _ := request(manager, "POST", legacyPath, "", legacyPack); code != 201 {
		t.Fatal("legacy package without policy upload failed")
	}
	defaultView := read(legacyPath + "/settings")
	if defaultView.Policy == nil || *defaultView.Policy.MaxFollowups != 2 || defaultView.Policy.Scope != "per_question" || defaultView.PolicySource != "built_in" {
		t.Fatal("missing publication policy did not get the built-in default")
	}
	if initial := enter(newClient(), "FN-legacy-policy-v1"); initial.Pack.Policy.MaxFollowups == nil || *initial.Pack.Policy.MaxFollowups != 2 || initial.Questions[0].FollowupPolicy == nil {
		t.Fatal("unconfigured legacy publication could not start immediately")
	}
	save(legacyPath+"/settings", read(legacyPath+"/settings"), runtimecfg.Settings{Policy: &domain.FollowupPolicy{Scope: "interview", MaxFollowups: &zero}})
	if legacy := enter(newClient(), "FN-legacy-policy-v1"); legacy.Pack.Policy.Scope != "interview" || *legacy.Pack.Policy.MaxFollowups != 0 {
		t.Fatal("explicit admin policy did not enable legacy publication entry")
	}
	legacySnapshot := enter(newClient(), "FN-settings-v1")
	process.stop()
	if _, err := db.Exec("DELETE FROM tw_interview_runtime WHERE interview_id=?", legacySnapshot.InterviewID); err != nil {
		t.Fatal(err)
	}
	// A pre-upgrade participant without a first task has only its original publication.
	legacySnapshot.Pack.Policy = domain.FollowupPolicy{Scope: "per_question", MaxFollowups: &limit}
	legacyStore, err := store.Open(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer legacyStore.Close()
	if _, err := legacyStore.Enqueue(context.Background(), "legacy-no-runtime", domain.Submit{Kind: "followup", QuestionID: "q_task", Snapshot: legacySnapshot}); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT contents FROM tw_interview_runtime WHERE interview_id=?", legacySnapshot.InterviewID).Scan(&frozenRaw); err != nil {
		t.Fatal(err)
	}
	var legacyFrozen runtimecfg.Frozen
	if json.Unmarshal(frozenRaw, &legacyFrozen) != nil || !legacyFrozen.Valid() || legacyFrozen.Followup.Hash != c.Release("followup").Hash || legacyFrozen.Report.Hash != c.Release("report").Hash {
		t.Fatal("legacy participant without tasks adopted new management defaults")
	}
	mu.Lock()
	finalCalls := len(requests)
	mu.Unlock()
	if finalCalls != 4 {
		t.Fatalf("unexpected model requests after browser flow: %d", finalCalls)
	}
	t.Log("Global/package inheritance, revision conflicts, immutable publication retry, startup freeze, actual frozen model requests, zero-followup policy, additive migration and PDF verified; real provider calls=0")
}
