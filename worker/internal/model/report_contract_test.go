package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type memoryStages struct {
	saved   map[string]json.RawMessage
	calls   []store.Call
	errors  []string
	checked []string
}

func (m *memoryStages) Stage(_ context.Context, _ store.Task, name string) (json.RawMessage, error) {
	m.checked = append(m.checked, name)
	return m.saved[name], nil
}
func (m *memoryStages) Checkpoint(_ context.Context, _ store.Task, name string, output any) error {
	raw, _ := json.Marshal(output)
	m.saved[name] = raw
	return nil
}
func (m *memoryStages) StartCall(_ context.Context, c store.Call) error {
	m.calls = append(m.calls, c)
	return nil
}
func (m *memoryStages) EndCall(_ context.Context, _, _ string, code *string) error {
	value := ""
	if code != nil {
		value = *code
	}
	m.errors = append(m.errors, value)
	return nil
}
func reportFixture() domain.Report {
	return domain.Report{Title: "合成报告", Sections: []domain.Section{{Title: "原文事实", Statements: []domain.Statement{{Kind: "fact", Text: "以记录核对质量", EvidenceIDs: []string{"E1"}}}}}, TaskCards: []domain.TaskCard{}, NeedsVerification: []string{}}
}
func setupModel(t *testing.T, outputs []any, corrections int) (*Client, *memoryStages, config.Release, config.Queue, *[]request) {
	t.Helper()
	requests := []request{}
	index := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		requests = append(requests, request)
		value := outputs[index]
		if index < len(outputs)-1 {
			index++
		}
		raw, _ := json.Marshal(value)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(raw)}, "finish_reason": "stop"}}})
	}))
	t.Cleanup(server.Close)
	memory := &memoryStages{saved: map[string]json.RawMessage{}}
	temp := 0.1
	provider := config.Provider{BaseURL: server.URL, APIKey: "synthetic-test-key", RequestTimeout: time.Second * 5}
	release := config.Release{Kind: "report", Provider: provider, Pipeline: config.Pipeline{MaxCorrections: corrections, Model: config.Model{Provider: "controlled", Name: "controlled-model", MaxTokens: 4096, Temperature: &temp, ResponseFormat: "json_object"}}}
	c := &Client{Store: memory, Config: config.Config{Providers: map[string]config.Provider{"controlled": provider}, Database: config.Database{ConnectTimeout: time.Second}}}
	return c, memory, release, config.Queue{MaxInputBytes: 100000, MaxOutputBytes: 100000}, &requests
}
func reportInput() domain.ReportContext {
	return domain.ReportContext{Evidence: []domain.Evidence{{ID: "E1", QuestionID: "Q01", Quote: "以记录核对质量"}}, Followups: []domain.Followup{}}
}

func TestReportCorrectionValidatesBeforeCheckpointAndReusesOnlyValidResult(t *testing.T) {
	invalid := reportFixture()
	invalid.Sections[0].Statements[0].EvidenceIDs = []string{}
	c, m, r, options, requests := setupModel(t, []any{invalid, reportFixture()}, 1)
	// Legacy invalid checkpoints remain intact and are not selected under the new contract.
	legacy, _ := json.Marshal(invalid)
	m.saved["compose"] = legacy
	var output domain.Report
	if err := c.Stage(context.Background(), store.Task{}, r, options, "compose", "合成报告任务", reportInput(), &output); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 || m.errors[0] != "INVALID_REPORT_CITATION" || m.errors[1] != "" {
		t.Fatalf("call outcomes: %v", m.errors)
	}
	if string(m.saved["compose"]) != string(legacy) || len(m.saved["report_compose_v2"]) == 0 {
		t.Fatal("legacy audit overwritten or validated result not cached")
	}
	if m.checked[0] != "report_compose_v2" {
		t.Fatal("legacy checkpoint was selected")
	}
	if !strings.Contains((*requests)[0].Messages[0].Content, `"minItems":1`) || !strings.Contains((*requests)[0].Messages[0].Content, `"enum":["E1"]`) {
		t.Fatal("citation schema constraints absent")
	}
	messages := (*requests)[1].Messages
	if len(messages) != 4 || !strings.Contains(messages[3].Content, "sections[0].statements[0].evidence_ids") {
		t.Fatal("correction did not carry exact failure feedback")
	}
	if err := c.Stage(context.Background(), store.Task{}, r, options, "compose", "合成报告任务", reportInput(), &output); err != nil || len(m.calls) != 2 {
		t.Fatal("valid checkpoint not reused")
	}
}
func TestReportCorrectionLimitAndUnknownIDsNeverPublish(t *testing.T) {
	invalid := reportFixture()
	invalid.Sections[0].Statements[0].EvidenceIDs = []string{"UNKNOWN"}
	c, m, r, options, _ := setupModel(t, []any{invalid}, 2)
	var output domain.Report
	err := c.Stage(context.Background(), store.Task{}, r, options, "compose", "合成报告任务", reportInput(), &output)
	if ErrorCode(err) != "INVALID_REPORT_CITATION" || len(m.calls) != 3 || len(m.saved) != 0 {
		t.Fatalf("unbounded or invalid output cached: %v", err)
	}
}
func TestZeroEvidenceRequiresOnlyNeedsVerificationAndNoCards(t *testing.T) {
	invalid := reportFixture()
	valid := domain.Report{Title: "合成证据不足", Sections: []domain.Section{{Title: "待核实", Statements: []domain.Statement{{Kind: "needs_verification", Text: "没有可引用证据", EvidenceIDs: []string{}}}}}, TaskCards: []domain.TaskCard{}, NeedsVerification: []string{"需要专家补充"}}
	c, m, r, options, _ := setupModel(t, []any{invalid, valid}, 1)
	var output domain.Report
	if err := c.Stage(context.Background(), store.Task{}, r, options, "compose", "合成报告任务", domain.ReportContext{Evidence: []domain.Evidence{}}, &output); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 || output.Sections[0].Statements[0].Kind != "needs_verification" {
		t.Fatal("zero evidence policy not enforced")
	}
}
func TestEvidenceValidationPrecedesCheckpointAndCanCorrectInventedQuote(t *testing.T) {
	bad := domain.EvidenceResult{Evidence: []domain.Evidence{{ID: "E1", QuestionID: "Q01", Quote: "不存在的引文"}}}
	good := domain.EvidenceResult{Evidence: reportInput().Evidence}
	c, m, r, options, _ := setupModel(t, []any{bad, good}, 1)
	var output domain.EvidenceResult
	input := domain.Snapshot{Answers: []domain.Answer{{QuestionID: "Q01", Text: "以记录核对质量", Confirmed: true}}}
	if err := c.Stage(context.Background(), store.Task{}, r, options, "analyze", "提取合成证据", input, &output); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 || m.errors[0] != "INVALID_EVIDENCE" || len(m.saved["report_analyze_v2"]) == 0 {
		t.Fatal("invented quote checkpointed")
	}
}
func TestCorruptNewCheckpointIsRejectedWithoutModelCalls(t *testing.T) {
	c, m, r, options, _ := setupModel(t, []any{reportFixture()}, 1)
	invalid := reportFixture()
	invalid.Sections[0].Statements[0].EvidenceIDs = []string{}
	m.saved["report_compose_v2"], _ = json.Marshal(invalid)
	var output domain.Report
	if c.Stage(context.Background(), store.Task{}, r, options, "compose", "合成报告任务", reportInput(), &output) == nil || len(m.calls) != 0 {
		t.Fatal("corrupt cache accepted")
	}
}
