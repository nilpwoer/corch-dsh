package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

var portalBrowser = flag.Bool("portal-browser", false, "Run installed Playwright/Chromium against the real portal process")
var portalBrowserHandoff = flag.String("portal-browser-handoff", "", "Write a synthetic browser fixture for an external browser and wait for its .done result")

// TestPortalAcceptance uses an isolated MySQL database and real API/consumer process; only the model is controlled.
func TestPortalAcceptance(t *testing.T) {
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
	db, err := sql.Open("mysql", dsn.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	name := "tw_portal_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := db.Exec("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = db.Exec("DROP DATABASE `" + name + "`") }()
	dsn.DBName = name
	c, err := config.Load("config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	legacyDB, err := sql.Open("mysql", dsn.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer legacyDB.Close()
	baseline, err := os.ReadFile("internal/store/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(baseline), ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err := legacyDB.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := legacyDB.Exec("INSERT INTO tw_schema(version) VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := legacyDB.Exec("INSERT INTO tw_interviews(id,input_version,input_hash,followup_release) VALUES ('legacy-preserved',1,?, '{}')", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	c.Database.DSN = dsn.FormatDSN()
	c.Mode = "both"
	c.Auth.Token = testToken
	c.Server.Listen = port(t)
	baseURL := "http://" + c.Server.Listen
	hash, err := accounts.Hash("synthetic-isolated-test-password")
	if err != nil {
		t.Fatal(err)
	}
	c.Portal = config.Portal{Enabled: true, AssetsDir: "../apps/web/public", PacksDir: t.TempDir(), Origin: baseURL, SessionTTL: time.Hour, MaxPackBytes: 1048576, AdminPasswordHash: hash, LoginLimit: 50, LoginWindow: time.Minute, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "deny", PollInterval: 40 * time.Millisecond, ModelLabel: "test-model"}
	modelFixture := &fakeModel{}
	model := httptest.NewServer(modelFixture)
	defer model.Close()
	provider := c.Providers["deepseek"]
	provider.BaseURL = model.URL
	provider.APIKey = "test-only-no-real-model"
	c.Providers["deepseek"] = provider
	c.Queue.PollInterval = 40 * time.Millisecond
	c.Queue.FollowupConcurrency = 2
	pipeline := c.Prompts["followup"]
	pipeline.MaxFollowups = 0
	c.Prompts["followup"] = pipeline

	root := t.TempDir()
	binary := acceptanceBinary(t, root)
	write := func() {
		raw, err := yaml.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "config.yaml"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	process := start(binary, filepath.Join(root, "config.yaml"))
	defer func() { process.stop() }()
	ready := func() {
		wait(t, func() bool {
			select {
			case <-process.done:
				t.Fatalf("portal exited: %s", process.log.String())
			default:
			}
			res, err := http.Get(baseURL + "/health")
			if err != nil {
				return false
			}
			res.Body.Close()
			return res.StatusCode == 200
		})
	}
	ready()
	var schemaVersion int
	if err := legacyDB.QueryRow("SELECT version FROM tw_schema").Scan(&schemaVersion); err != nil || schemaVersion != 5 {
		t.Fatal("version 1 migration failed")
	}
	var preserved int
	if err := legacyDB.QueryRow("SELECT COUNT(*) FROM tw_interviews WHERE id='legacy-preserved'").Scan(&preserved); err != nil || preserved != 1 {
		t.Fatal("migration lost legacy data")
	}
	adminJar, _ := cookiejar.New(nil)
	expertJar, _ := cookiejar.New(nil)
	manager := &http.Client{Jar: adminJar, Timeout: 5 * time.Second}
	expert := &http.Client{Jar: expertJar, Timeout: 5 * time.Second}
	req := func(browser *http.Client, method, path, key string, value any) (int, []byte) {
		var body io.Reader
		if value != nil {
			raw, _ := json.Marshal(value)
			body = bytes.NewReader(raw)
		}
		r, _ := http.NewRequest(method, baseURL+path, body)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", baseURL)
		r.Header.Set("Idempotency-Key", key)
		res, err := browser.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}
	if status, _ := req(expert, "GET", "/admin/api/reports", "", nil); status != 401 {
		t.Fatal("anonymous report access")
	}
	if status, data := req(manager, "POST", "/admin/api/login", "", map[string]string{"username": "admin", "password": "synthetic-isolated-test-password"}); status != 200 {
		t.Fatalf("login: %d %s", status, data)
	}
	pack := map[string]any{"schemaVersion": 1, "fieldnoteId": "FN-portal", "publicFieldnoteId": "FN-portal", "goal": "真实任务证据", "questionPackMeta": map[string]any{"packId": "pack-portal", "version": 1}, "profile": domain.Profile{Name: "专家", Role: "审查"}, "questions": []any{map[string]any{"id": "q_task", "title": "质量依据", "type": "开放回忆", "question": "请描述任务质量依据", "followUp": "可选提示"}}, "interviewPolicy": map[string]any{"scope": "per_question", "maxFollowups": 0}, "invitation": map[string]any{"code": "000000", "createdAt": "test-only", "status": "active"}}
	pack["questions"].([]any)[0].(map[string]any)["sourceRefs"] = []any{map[string]any{"sourceType": "note", "title": "Synthetic reference", "locator": "local:fixture", "excerpt": "Synthetic excerpt", "requiresConfirmation": true}}
	if status, data := req(manager, "POST", "/admin/api/packs/FN-portal-v1", "", pack); status != 201 {
		t.Fatalf("upload: %d %s", status, data)
	}
	if *portalBrowser || *portalBrowserHandoff != "" {
		browserPack := map[string]any{}
		encoded, _ := json.Marshal(pack)
		_ = json.Unmarshal(encoded, &browserPack)
		browserPack["fieldnoteId"] = "FN-browser"
		browserPack["publicFieldnoteId"] = "FN-browser"
		browserPack["questions"] = []any{map[string]any{"id": "q_task", "title": "质量依据", "type": "授权确认", "question": "请说明质量依据", "options": []string{"选项一", "选项二"}}, map[string]any{"id": "q_other", "title": "其他", "type": "开放回忆", "question": "其他经验"}}
		browserPack["questions"].([]any)[0].(map[string]any)["sourceRefs"] = pack["questions"].([]any)[0].(map[string]any)["sourceRefs"]
		encoded, _ = json.Marshal(browserPack)
		file := filepath.Join(root, "browser-pack.json")
		if err := os.WriteFile(file, encoded, 0600); err != nil {
			t.Fatal(err)
		}
		if *portalBrowserHandoff != "" {
			handoff, _ := json.Marshal(map[string]string{"origin": baseURL, "pack_file": file})
			if err := os.WriteFile(*portalBrowserHandoff, handoff, 0600); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(120 * time.Second)
			for {
				result, err := os.ReadFile(*portalBrowserHandoff + ".done")
				if err == nil {
					if strings.TrimSpace(string(result)) != "PASS" {
						t.Fatal("external browser failed")
					}
					break
				}
				if !os.IsNotExist(err) || time.Now().After(deadline) {
					t.Fatal("external browser handoff timed out")
				}
				time.Sleep(100 * time.Millisecond)
			}
		} else {
			command := exec.Command("node", "tests/portal-browser.mjs", baseURL, file)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("browser: %v\n%s", err, output)
			} else {
				t.Log(string(output))
			}
		}
	}
	if status, _ := req(expert, "GET", "/portal/api/packs", "", nil); status != 404 {
		t.Fatal("link-only configuration exposed public list")
	}
	if status, _ := req(expert, "POST", "/portal/api/session", "", map[string]string{"key": "FN-portal-v1", "code": "wrong"}); status != 401 {
		t.Fatal("invalid invitation accepted")
	}
	followPack := map[string]any{}
	encodedFollow, _ := json.Marshal(pack)
	_ = json.Unmarshal(encodedFollow, &followPack)
	followPack["fieldnoteId"] = "FN-slotless"
	followPack["publicFieldnoteId"] = "FN-slotless"
	followPack["interviewPolicy"] = map[string]any{"scope": "per_question", "maxFollowups": 1}
	if status, data := req(manager, "POST", "/admin/api/packs/FN-slotless-v1", "", followPack); status != 201 {
		t.Fatalf("slotless upload: %d %s", status, data)
	}
	followJar, _ := cookiejar.New(nil)
	followClient := &http.Client{Jar: followJar, Timeout: 5 * time.Second}
	followStatus, followData := req(followClient, "POST", "/portal/api/session", "", map[string]string{"key": "FN-slotless-v1", "code": "000000"})
	if followStatus != 200 {
		t.Fatalf("slotless session: %d %s", followStatus, followData)
	}
	var followSession struct {
		Snapshot domain.Snapshot `json:"snapshot_template"`
	}
	_ = json.Unmarshal(followData, &followSession)
	followInput := domain.Submit{Kind: "followup", QuestionID: "q_task", Snapshot: followSession.Snapshot}
	followInput.Snapshot.Answers = []domain.Answer{{QuestionID: "q_task", Text: answerText, Confirmed: true}}
	followStatus, followData = req(followClient, "POST", "/portal/api/tasks", "slotless-first", followInput)
	if followStatus != 202 {
		t.Fatalf("slotless submit: %d %s", followStatus, followData)
	}
	var followTask store.Task
	_ = json.Unmarshal(followData, &followTask)
	wait(t, func() bool {
		_, followData = req(followClient, "GET", "/portal/api/tasks/"+followTask.ID, "", nil)
		_ = json.Unmarshal(followData, &followTask)
		return followTask.Status == "succeeded" || followTask.Status == "failed"
	})
	if followTask.Status != "succeeded" || !bytes.Contains(followTask.Output, []byte("followup_ready")) || bytes.Contains(followTask.Output, []byte("missing_slots")) {
		t.Fatalf("slotless model output/package limit: %s", followData)
	}
	followInput.Snapshot.InputVersion++
	followInput.Snapshot.Answers[0].Text += " 补充实际记录内容。"
	followStatus, followData = req(followClient, "POST", "/portal/api/tasks", "slotless-second", followInput)
	if followStatus != 202 {
		t.Fatalf("slotless second submit: %d %s", followStatus, followData)
	}
	_ = json.Unmarshal(followData, &followTask)
	wait(t, func() bool {
		_, followData = req(followClient, "GET", "/portal/api/tasks/"+followTask.ID, "", nil)
		_ = json.Unmarshal(followData, &followTask)
		return followTask.Status == "succeeded" || followTask.Status == "failed"
	})
	if followTask.Status != "succeeded" || !bytes.Contains(followTask.Output, []byte("FOLLOWUP_LIMIT")) {
		t.Fatal("package count not enforced on supplementary answer")
	}
	status, data := req(expert, "POST", "/portal/api/session", "", map[string]string{"key": "FN-portal-v1", "code": "000000"})
	if status != 200 || bytes.Contains(data, []byte(`"invitation"`)) || bytes.Contains(data, []byte("000000")) {
		t.Fatalf("session: %d %s", status, data)
	}
	var session struct {
		Snapshot    domain.Snapshot `json:"snapshot_template"`
		InterviewID string          `json:"interview_id"`
	}
	if err := json.Unmarshal(data, &session); err != nil {
		t.Fatal(err)
	}
	otherJar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: otherJar, Timeout: 5 * time.Second}
	if status, _ := req(other, "POST", "/portal/api/session", "", map[string]string{"key": "FN-portal-v1", "code": "000000"}); status != 200 {
		t.Fatal("second participant session failed")
	}
	sub := domain.Submit{Kind: "followup", QuestionID: "q_task", Snapshot: session.Snapshot}
	sub.Snapshot.Answers = []domain.Answer{{QuestionID: "q_task", Text: answerText, Confirmed: true}}
	status, data = req(expert, "POST", "/portal/api/tasks", "portal-answer", sub)
	if status != 202 {
		t.Fatalf("answer: %d %s", status, data)
	}
	var task store.Task
	_ = json.Unmarshal(data, &task)
	if status, _ := req(other, "GET", "/portal/api/tasks/"+task.ID, "", nil); status != 404 {
		t.Fatal("cross-session task access")
	}
	if status, _ := req(other, "POST", "/portal/api/tasks", "cross-session", sub); status != 409 {
		t.Fatal("cross-session submission")
	}
	forged, _ := http.NewRequest("POST", baseURL+"/portal/api/tasks", strings.NewReader("{}"))
	forged.Header.Set("Origin", "http://attacker.invalid")
	forgedResponse, err := expert.Do(forged)
	if err != nil {
		t.Fatal(err)
	}
	forgedResponse.Body.Close()
	if forgedResponse.StatusCode != 403 {
		t.Fatal("portal CSRF accepted")
	}
	duplicateStatus, duplicate := req(expert, "POST", "/portal/api/tasks", "portal-answer", sub)
	var repeated store.Task
	_ = json.Unmarshal(duplicate, &repeated)
	if duplicateStatus != 202 || repeated.ID != task.ID {
		t.Fatal("idempotency failed")
	}
	settle := func() {
		wait(t, func() bool {
			_, data = req(expert, "GET", "/portal/api/tasks/"+task.ID, "", nil)
			_ = json.Unmarshal(data, &task)
			return task.Status == "succeeded" || task.Status == "failed"
		})
		if task.Status != "succeeded" {
			t.Fatalf("task failed: %s", data)
		}
	}
	settle()
	if !bytes.Contains(task.Output, []byte("FOLLOWUP_LIMIT")) {
		t.Fatal("package zero limit ignored")
	}
	if status, _ := req(manager, "DELETE", "/admin/api/packs/FN-portal-v1", "", nil); status != 200 {
		t.Fatal("removal failed")
	}
	if status, data := req(expert, "GET", "/portal/api/session?fieldnoteId=FN-portal-v1", "", nil); status != 200 || !bytes.Contains(data, []byte("pack-portal")) {
		t.Fatal("session lost pinned package")
	}
	sub.Kind = "report"
	sub.QuestionID = ""
	status, data = req(expert, "POST", "/portal/api/tasks", "portal-report", sub)
	if status != 202 {
		t.Fatalf("report: %d %s", status, data)
	}
	_ = json.Unmarshal(data, &task)
	settle()
	if len(task.Output) > 0 && string(task.Output) != "null" {
		t.Fatal("participant report output leaked")
	}
	if status, data := req(manager, "GET", "/admin/api/reports/"+task.ID, "", nil); status != 200 || !bytes.Contains(data, []byte("evidence")) {
		t.Fatalf("admin report: %d %s", status, data)
	}
	t.Run("source_refs_mysql_round_trip_and_legacy_regeneration", func(t *testing.T) {
		verifySourceRefCompatibility(t, legacyDB, req, expert, session.InterviewID, sub, task)
	})
	wholePack := map[string]any{}
	encodedWhole, _ := json.Marshal(pack)
	_ = json.Unmarshal(encodedWhole, &wholePack)
	wholePack["fieldnoteId"] = "FN-whole"
	wholePack["publicFieldnoteId"] = "FN-whole"
	wholePack["questions"] = []any{map[string]any{"id": "q_task", "title": "Task", "type": "Open", "question": "Task detail"}, map[string]any{"id": "q_other", "title": "Other", "type": "Open", "question": "Other detail"}}
	wholePack["interviewPolicy"] = map[string]any{"scope": "interview", "maxFollowups": 1}
	if status, data := req(manager, "POST", "/admin/api/packs/FN-whole-v1", "", wholePack); status != 201 {
		t.Fatalf("whole package: %d %s", status, data)
	}
	wholeJar, _ := cookiejar.New(nil)
	wholeClient := &http.Client{Jar: wholeJar, Timeout: 5 * time.Second}
	wholeStatus, wholeData := req(wholeClient, "POST", "/portal/api/session", "", map[string]string{"key": "FN-whole-v1", "code": "000000"})
	if wholeStatus != 200 {
		t.Fatalf("whole session: %d %s", wholeStatus, wholeData)
	}
	var wholeSession struct {
		Snapshot domain.Snapshot `json:"snapshot_template"`
	}
	_ = json.Unmarshal(wholeData, &wholeSession)
	wholeInput := domain.Submit{Kind: "followup", QuestionID: "q_task", Snapshot: wholeSession.Snapshot}
	wholeInput.Snapshot.Answers = []domain.Answer{{QuestionID: "q_task", Text: answerText, Confirmed: true}, {QuestionID: "q_other", Text: "其他实际回答", Confirmed: true}}
	modelFixture.held = make(chan struct{})
	modelFixture.release = make(chan struct{})
	modelFixture.holdNext.Store(true)
	firstStatus, firstData := req(wholeClient, "POST", "/portal/api/tasks", "whole-first", wholeInput)
	if firstStatus != 202 {
		t.Fatalf("whole first: %d %s", firstStatus, firstData)
	}
	var heldTask store.Task
	_ = json.Unmarshal(firstData, &heldTask)
	wait(t, func() bool {
		select {
		case <-modelFixture.held:
			return true
		default:
			return false
		}
	})
	wholeInput.QuestionID = "q_other"
	secondStatus, secondData := req(wholeClient, "POST", "/portal/api/tasks", "whole-second", wholeInput)
	if secondStatus != 202 {
		t.Fatalf("whole second: %d %s", secondStatus, secondData)
	}
	var publishedTask store.Task
	_ = json.Unmarshal(secondData, &publishedTask)
	wait(t, func() bool {
		_, secondData = req(wholeClient, "GET", "/portal/api/tasks/"+publishedTask.ID, "", nil)
		_ = json.Unmarshal(secondData, &publishedTask)
		return publishedTask.Status == "succeeded" || publishedTask.Status == "failed"
	})
	close(modelFixture.release)
	wait(t, func() bool {
		_, firstData = req(wholeClient, "GET", "/portal/api/tasks/"+heldTask.ID, "", nil)
		_ = json.Unmarshal(firstData, &heldTask)
		return heldTask.Status == "succeeded" || heldTask.Status == "failed"
	})
	if publishedTask.Status != "succeeded" || !bytes.Contains(publishedTask.Output, []byte("followup_ready")) || heldTask.Status != "succeeded" || !bytes.Contains(heldTask.Output, []byte("FOLLOWUP_LIMIT")) {
		t.Fatal("whole-interview limit was not fenced at final publication")
	}
	process.stop()
	c.Portal.AdminPasswordHash = ""
	write()
	process = start(binary, filepath.Join(root, "config.yaml"))
	ready()
	if status, data := req(expert, "GET", "/portal/api/session", "", nil); status != 200 || !bytes.Contains(data, []byte(`"frozen":true`)) {
		t.Fatalf("restoration: %d %s", status, data)
	}
	if status, _ := req(manager, "POST", "/admin/api/logout", "", nil); status != 200 {
		t.Fatal("logout failed")
	}
	if status, _ := req(manager, "GET", "/admin/api/reports", "", nil); status != 401 {
		t.Fatal("session not revoked")
	}
	s, err := store.Open(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var account store.Account
	if err := s.DB.Where("username=?", "admin").Take(&account).Error; err != nil || account.PasswordHash == "synthetic-isolated-test-password" || !accounts.Verify(account.PasswordHash, "synthetic-isolated-test-password") {
		t.Fatal("database password hashing failed")
	}
}
