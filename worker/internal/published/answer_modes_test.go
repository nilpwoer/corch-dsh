package published

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

func TestExplicitModesSurvivePublicationAndFrozenSnapshot(t *testing.T) {
	for _, mode := range []string{"text", "choice", "mixed", "other"} {
		t.Run(mode, func(t *testing.T) {
			p, _, err := Parse([]byte(fixture))
			if err != nil {
				t.Fatal(err)
			}
			limit := 2
			p.Policy = &domain.FollowupPolicy{Scope: "per_question", MaxFollowups: &limit}
			p.Goal = "synthetic"
			q := &p.Questions[0]
			q.AnswerMode = &mode
			if mode != "text" {
				q.Options = []string{"常规方式", "其他（请说明）"}
			}
			policy, err := domain.ExplicitQuestionPolicy(mode, q.Type, q.Options)
			if err != nil {
				t.Fatal(err)
			}
			q.FollowupPolicy = &policy
			raw, _ := json.Marshal(p)
			parsed, _, err := Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			frozen, _ := json.Marshal(parsed.NewInterviewCopy())
			edited := parsed
			edited.Questions = append([]Question(nil), parsed.Questions...)
			choice := "choice"
			if mode != "text" {
				edited.Questions[0].AnswerMode = &choice
			}
			restored, _, err := Parse(frozen)
			if err != nil {
				t.Fatal(err)
			}
			if *restored.Questions[0].AnswerMode != mode || !reflect.DeepEqual(restored.Questions[0].FollowupPolicy, &policy) {
				t.Fatal("saved mode changed")
			}
			rawView, _ := json.Marshal(restored.ParticipantView())
			var view map[string]any
			_ = json.Unmarshal(rawView, &view)
			displayed := view["questions"].([]any)[0].(map[string]any)
			if displayed["answerMode"] != mode {
				t.Fatal("participant mode lost")
			}
			// Snapshot policies are authoritative even when the question has auxiliary options.
			entry := Entry{Key: "synthetic", Pack: restored.NewInterviewCopy()}
			snapshot, err := entry.Snapshot("synthetic-interview")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(snapshot.Questions[0].FollowupPolicy, &policy) || !reflect.DeepEqual(snapshot.Questions[0].Options, q.Options) {
				t.Fatal("snapshot controls lost")
			}
			max := 0
			if mode != "choice" {
				max = 2
			}
			if policy.MaxFollowups != max {
				t.Fatal("unexpected ceiling")
			}
		})
	}
}

func TestInvalidModesAndContradictoryPoliciesAreRejected(t *testing.T) {
	for _, mode := range []string{"", "unknown", "text", "mixed", "other", "choice"} {
		p, _, _ := Parse([]byte(fixture))
		p.Questions[0].AnswerMode = &mode
		// No options makes all option modes invalid; text is paired with a forged policy.
		forged := domain.QuestionFollowupPolicy{Input: "none"}
		p.Questions[0].FollowupPolicy = &forged
		raw, _ := json.Marshal(p)
		if _, _, err := Parse(raw); err == nil {
			t.Fatalf("invalid mode/policy accepted: %s", mode)
		}
	}
	p, _, _ := Parse([]byte(fixture))
	mode := "mixed"
	p.Questions[0].AnswerMode = &mode
	p.Questions[0].Options = []string{"甲"}
	raw, _ := json.Marshal(p)
	if _, _, err := Parse(raw); err == nil {
		t.Fatal("explicit mode without policy accepted")
	}
	p.Questions[0].AnswerMode = nil
	original, _ := json.Marshal(p)
	fresh := p.NewInterviewCopy()
	after, _ := json.Marshal(p)
	if string(original) != string(after) || fresh.Questions[0].FollowupPolicy.Input != "none" {
		t.Fatal("legacy publication mutated or reinterpreted")
	}
}
