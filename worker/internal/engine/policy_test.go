package engine

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type controlledStages struct {
	calls  []string
	inputs []json.RawMessage
	status string
}

func (m *controlledStages) Stage(_ context.Context, _ store.Task, _ config.Release, _ config.Queue, name, _ string, input, output any) error {
	m.calls = append(m.calls, name)
	raw, _ := json.Marshal(input)
	m.inputs = append(m.inputs, raw)
	if name == "analyze" {
		*output.(*domain.Analysis) = domain.Analysis{Status: m.status, Reason: "based on actual answer", CoveredSlots: []string{}, MissingSlots: []string{}}
	} else {
		raw, _ := json.Marshal(map[string]string{"text": "请补充具体案例"})
		return json.Unmarshal(raw, output)
	}
	return nil
}
func policyInput(scope string, limit int) store.Input {
	return store.Input{Submit: domain.Submit{Kind: "followup", QuestionID: "Q01", Snapshot: domain.Snapshot{InterviewID: "test", InputVersion: 1, QuestionPackVersion: 1, Pack: &domain.PackContext{Key: "test-v1", PackID: "test", Hash: "test-hash", Goal: "真实任务证据", Policy: domain.FollowupPolicy{Scope: scope, MaxFollowups: &limit}}, Questions: []domain.Question{{ID: "Q01", Text: "说明真实任务", FollowUp: "可选提示"}}, Answers: []domain.Answer{{QuestionID: "Q01", Text: "任务描述", Confirmed: true}}}}}
}
func TestPackagePolicyOverridesServerCountsWithoutSlots(t *testing.T) {
	model := &controlledStages{status: "incomplete"}
	e := Engine{Model: model}
	in := policyInput("per_question", 2)
	result, err := e.Process(context.Background(), store.Task{}, in, config.Release{Pipeline: config.Pipeline{MaxFollowups: 0}}, config.Queue{})
	if err != nil || result.(domain.FollowupResult).Status != "followup_ready" || len(model.calls) != 2 {
		t.Fatalf("package policy not used: %v %v", result, err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(model.inputs[0], &payload); err != nil {
		t.Fatal(err)
	}
	if payload["pack"] == nil || payload["answer_history"] == nil {
		t.Fatal("goal or answer history missing")
	}
	model.calls = nil
	model.status = "complete"
	result, err = e.Process(context.Background(), store.Task{}, in, config.Release{}, config.Queue{})
	if err != nil || result.(domain.FollowupResult).Status != "complete" || len(model.calls) != 1 {
		t.Fatal("sufficient answer unnecessarily composed a followup")
	}
}
func TestZeroAndWholeInterviewLimitsDoNotCallModels(t *testing.T) {
	for _, in := range []store.Input{policyInput("per_question", 0), policyInput("interview", 1)} {
		in.Followups = []domain.Followup{{QuestionID: "Q02", Text: "already published"}}
		model := &controlledStages{status: "incomplete"}
		result, err := (&Engine{Model: model}).Process(context.Background(), store.Task{}, in, config.Release{Pipeline: config.Pipeline{MaxFollowups: 10}}, config.Queue{})
		if err != nil || result.(domain.FollowupResult).Reason != "FOLLOWUP_LIMIT" || len(model.calls) != 0 {
			t.Fatal("business limit ignored")
		}
	}
}

func TestOnlyActualTextInputsCanCallFollowupModels(t *testing.T) {
	text := "这是其他方式的真实说明"
	for _, tc := range []struct {
		name, kind        string
		options, selected []string
		text              string
		wantCalls         int
	}{
		{"consent", "授权确认", []string{"同意", "其他"}, []string{"同意"}, "", 0},
		{"pure choice", "单项选择", []string{"甲", "乙"}, []string{"甲"}, "", 0},
		{"other not selected", "多项选择", []string{"甲", "其他"}, []string{"甲"}, text, 0},
		{"other empty", "多项选择", []string{"甲", "其他"}, []string{"其他"}, "", 0},
		{"other written", "多项选择", []string{"甲", "其他"}, []string{"其他"}, text, 2},
		{"open written", "开放回忆", nil, nil, text, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := policyInput("per_question", 2)
			policy := domain.QuestionPolicy(tc.kind, tc.options)
			in.Submit.Snapshot.Questions[0].FollowupPolicy = &policy
			in.Submit.Snapshot.Questions[0].Options = tc.options
			in.Submit.Snapshot.Answers[0].TextInput = &tc.text
			in.Submit.Snapshot.Answers[0].SelectedOptions = tc.selected
			model := &controlledStages{status: "incomplete"}
			_, err := (&Engine{Model: model}).Process(context.Background(), store.Task{}, in, config.Release{}, config.Queue{})
			if err != nil || len(model.calls) != tc.wantCalls {
				t.Fatalf("unexpected model calls %d, err %v", len(model.calls), err)
			}
			if tc.wantCalls > 0 {
				in.Followups = []domain.Followup{{QuestionID: "Q01"}, {QuestionID: "Q01"}}
				model.calls = nil
				_, err = (&Engine{Model: model}).Process(context.Background(), store.Task{}, in, config.Release{}, config.Queue{})
				if err != nil || len(model.calls) != 0 {
					t.Fatal("third followup called a model")
				}
			}
		})
	}
}
