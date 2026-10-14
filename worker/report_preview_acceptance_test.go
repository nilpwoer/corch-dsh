package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
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

var reportBrowserHandoff = flag.String("report-browser-handoff", "", "Synthetic saved-report browser fixture; wait for its .done result")

// TestReportPreviewAcceptance seeds only a disposable database; API-only mode cannot call models.
func TestReportPreviewAcceptance(t *testing.T) {
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
	name := "tw_report_view_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	c, err := config.Load("config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	c.Database.DSN = dsn.FormatDSN()
	c.Mode = "api"
	c.Auth.Token = testToken
	c.Server.Listen = port(t)
	base := "http://" + c.Server.Listen
	hash, err := accounts.Hash("synthetic-isolated-report-password")
	if err != nil {
		t.Fatal(err)
	}
	c.Portal = config.Portal{Enabled: true, AssetsDir: "../apps/web/public", PacksDir: t.TempDir(), Origin: base, SessionTTL: time.Hour, MaxPackBytes: 1048576, AdminPasswordHash: hash, LoginLimit: 50, LoginWindow: time.Minute, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", PollInterval: 40 * time.Millisecond, ModelLabel: "合成报告验收，不调用模型"}
	root := t.TempDir()
	binary := acceptanceBinary(t, root)
	configPath := filepath.Join(root, "config.yaml")
	write := func() {
		raw, err := yaml.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(configPath, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	process := start(binary, configPath)
	defer func() { process.stop() }()
	ready := func() {
		wait(t, func() bool {
			select {
			case <-process.done:
				t.Fatalf("API fixture exited: %s", process.log.String())
			default:
			}
			res, err := http.Get(base + "/health")
			if err != nil {
				return false
			}
			res.Body.Close()
			return res.StatusCode == 200
		})
	}
	ready()
	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar, Timeout: 30 * time.Second}
	}
	manager, owner, other, anonymous := newClient(), newClient(), newClient(), newClient()
	backendClient := newClient()
	request := func(client *http.Client, method, path, key string, body any) (int, []byte, http.Header) {
		var reader io.Reader
		if body != nil {
			encoded, _ := json.Marshal(body)
			reader = bytes.NewReader(encoded)
		}
		req, _ := http.NewRequest(method, base+path, reader)
		req.Header.Set("Origin", base)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		if client == backendClient {
			req.Header.Set("Authorization", "Bearer "+testToken)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, data, res.Header
	}
	if status, _, _ := request(manager, "POST", "/admin/api/login", "", map[string]string{"username": "admin", "password": "synthetic-isolated-report-password"}); status != 200 {
		t.Fatal("synthetic admin login failed")
	}
	pack := map[string]any{"schemaVersion": 1, "fieldnoteId": "FN-report-preview", "publicFieldnoteId": "FN-report-preview", "goal": "合成报告预览验收", "questionPackMeta": map[string]any{"packId": "synthetic-report-pack", "version": 1}, "profile": domain.Profile{Name: "合成专家", Role: "合成教师"}, "questions": []any{map[string]any{"id": "Q01", "title": "合成问题", "type": "开放回答", "question": "请描述合成测试。"}}, "interviewPolicy": map[string]any{"scope": "per_question", "maxFollowups": 0}, "invitation": map[string]any{"code": "000000", "createdAt": "synthetic-test-only", "status": "active"}}
	if status, body, _ := request(manager, "POST", "/admin/api/packs/FN-report-preview-v1", "", pack); status != 201 {
		t.Fatalf("synthetic upload: %d %s", status, body)
	}
	var snapshot domain.Snapshot
	for _, client := range []*http.Client{owner, other} {
		status, body, _ := request(client, "POST", "/portal/api/session", "", map[string]string{"key": "FN-report-preview-v1", "code": "000000"})
		if status != 200 {
			t.Fatal("synthetic participant login failed")
		}
		if client == owner {
			var session struct {
				Snapshot domain.Snapshot `json:"snapshot_template"`
			}
			if json.Unmarshal(body, &session) != nil {
				t.Fatal("fixture snapshot")
			}
			snapshot = session.Snapshot
		}
	}
	quote := "这是一份用于中文排版、分页和证据引用验收的合成回答。<img src=x onerror=alert(1)>"
	snapshot.Answers = []domain.Answer{{QuestionID: "Q01", Text: quote, Confirmed: true}}
	var latest store.Task
	for version := int64(1); version <= 3; version++ {
		status, body, _ := request(owner, "POST", "/portal/api/tasks", fmt.Sprintf("synthetic-report-%d", version), domain.Submit{Kind: "report", Snapshot: snapshot})
		if status != 202 || json.Unmarshal(body, &latest) != nil {
			t.Fatalf("seed report: %d %s", status, body)
		}
		if version == 2 {
			if _, err := db.Exec("UPDATE tw_tasks SET status='failed',error_code='INVALID_REPORT_CITATION' WHERE id=?", latest.ID); err != nil {
				t.Fatal(err)
			}
			continue
		}
		text := "合成报告正文：按原文核对引用，区分事实、解释与待核实事项。"
		if version == 3 {
			text = "长文开始标记\n"
			for i := 1; i <= 160; i++ {
				text += fmt.Sprintf("段落%03d：这是中文长文排版的合成记录，包含教学情境、判断依据与适用边界；每一段都必须完整保留，不得截断。\n", i)
			}
			text += "长文结束标记。" + strings.Repeat("LongUnbrokenIdentifier", 30)
		}
		result := domain.ReportResult{ReportVersion: version, InputVersion: 1, Report: domain.Report{Title: "实践专家访谈报告（合成验收） <script>不能执行</script>", Sections: []domain.Section{{Title: "专家确认摘要", Statements: []domain.Statement{{Kind: "fact", Text: text, EvidenceIDs: []string{"E1", "E2"}}, {Kind: "interpretation", Text: "这段内容仅用于检查网页与 PDF 的一致展示。", EvidenceIDs: []string{"E1", "E2"}}, {Kind: "needs_verification", Text: "实际情境与适用范围待进一步核实。", EvidenceIDs: []string{}}}}}, TaskCards: []domain.TaskCard{{Title: "核对原文与课堂记录", Trigger: "收到合成作品", Context: "合成课程", Steps: []string{"检查原始作品", "与课堂记录相互核对"}, Judgments: []string{"依据是否完整"}, Tools: []string{"合成记录表"}, Collaboration: "与合成教研组核实", QualityEvidence: "保留原始记录", Boundaries: "不作为真实访谈事实", EvidenceIDs: []string{"E1", "E2"}}}, NeedsVerification: []string{"评价标准尚待核实。"}}, Evidence: []domain.Evidence{{ID: "E1", QuestionID: "Q01", Quote: quote}, {ID: "E2", QuestionID: "Q01", Quote: quote}}}
		encoded, _ := json.Marshal(result)
		if _, err := db.Exec("UPDATE tw_tasks SET status='succeeded',output=? WHERE id=?", encoded, latest.ID); err != nil {
			t.Fatal(err)
		}
	}
	var beforeInput, beforeOutput []byte
	if err := db.QueryRow("SELECT input,output FROM tw_tasks WHERE id=?", latest.ID).Scan(&beforeInput, &beforeOutput); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"view", "pdf"} {
		adminPath := "/admin/api/reports/" + latest.ID + "/" + format
		ownerPath := "/portal/api/tasks/" + latest.ID + "/" + format
		backendPath := "/v1/tasks/" + latest.ID + "/" + format
		for _, path := range []string{adminPath, ownerPath, backendPath} {
			if status, _, _ := request(anonymous, "GET", path, "", nil); status != 401 {
				t.Fatal("anonymous report access")
			}
		}
		if status, _, _ := request(other, "GET", ownerPath, "", nil); status != 404 {
			t.Fatal("cross-participant report access")
		}
		for _, entry := range []struct {
			client *http.Client
			path   string
		}{{manager, adminPath}, {owner, ownerPath}, {backendClient, backendPath}} {
			status, body, headers := request(entry.client, "GET", entry.path, "", nil)
			if status != 200 || !strings.Contains(headers.Get("Cache-Control"), "no-store") {
				t.Fatalf("authorized saved report %s: %d", format, status)
			}
			if format == "view" {
				if bytes.Contains(body, []byte("<script>")) || bytes.Contains(body, []byte("<img src=")) || !bytes.Contains(body, []byte("#evidence-E1")) || !strings.Contains(headers.Get("Content-Security-Policy"), "default-src 'none'") {
					t.Fatal("unsafe or incomplete HTML preview")
				}
			} else if !bytes.HasPrefix(body, []byte("%PDF-")) || headers.Get("Content-Type") != "application/pdf" || !strings.Contains(headers.Get("Content-Disposition"), ".pdf") {
				t.Fatal("download is not a PDF")
			}
		}
	}
	var failedID string
	if err := db.QueryRow("SELECT id FROM tw_tasks WHERE interview_id=? AND report_version=2", snapshot.InterviewID).Scan(&failedID); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"view", "pdf"} {
		if status, _, _ := request(manager, "GET", "/admin/api/reports/"+failedID+"/"+format, "", nil); status != 409 {
			t.Fatal("failed report rendered")
		}
	}
	if *reportBrowserHandoff != "" {
		u, _ := http.NewRequest("GET", base, nil)
		cookie := ""
		for _, value := range owner.Jar.Cookies(u.URL) {
			if value.Name == "teaching_interview" {
				cookie = value.Value
			}
		}
		fixture, _ := json.Marshal(map[string]any{"origin": base, "task_id": latest.ID, "interview_id": snapshot.InterviewID, "participant_cookie": cookie, "failed_task_id": failedID})
		if err := os.WriteFile(*reportBrowserHandoff, fixture, 0600); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(150 * time.Second)
		for {
			result, err := os.ReadFile(*reportBrowserHandoff + ".done")
			if err == nil {
				if strings.TrimSpace(string(result)) != "PASS" {
					t.Fatal("report browser failed")
				}
				break
			}
			if !os.IsNotExist(err) || time.Now().After(deadline) {
				t.Fatal("report browser timed out")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	process.stop()
	c.Portal.ParticipantReports = "deny"
	write()
	process = start(binary, configPath)
	ready()
	for _, format := range []string{"view", "pdf"} {
		if status, _, _ := request(owner, "GET", "/portal/api/tasks/"+latest.ID+"/"+format, "", nil); status != 403 {
			t.Fatal("participant deny policy bypassed")
		}
	}
	var calls int
	if err := db.QueryRow("SELECT COUNT(*) FROM tw_calls").Scan(&calls); err != nil || calls != 0 {
		t.Fatal("report viewing unexpectedly called a model")
	}
	var afterInput, afterOutput []byte
	if err := db.QueryRow("SELECT input,output FROM tw_tasks WHERE id=?", latest.ID).Scan(&afterInput, &afterOutput); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeInput, afterInput) || !bytes.Equal(beforeOutput, afterOutput) {
		t.Fatal("preview or download rewrote saved report")
	}
	t.Log("Saved-report HTML/PDF, Chinese long text, XSS escaping, anonymous/cross-session/deny-policy protection, failed states, unchanged history, zero model calls verified")
}
