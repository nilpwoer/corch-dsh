package domain

import "testing"

func TestQuestionPolicyMatchesTextControls(t *testing.T) {
	for _, tc := range []struct {
		name, kind, input string
		options           []string
	}{
		{"open", "开放回忆", "text", nil},
		{"unknown open", "访谈叙述", "text", nil},
		{"choice only", "单项选择", "none", []string{"选项甲", "不适用"}},
		{"missing choice options", "多项选择", "none", nil},
		{"other conditional", "多项选择", "other", []string{"选项甲", "其他（请说明）"}},
		{"English other", "radio", "other", []string{"A", "Other: specify"}},
		{"not another department", "单项选择", "none", []string{"其他部门"}},
		{"consent", "授权确认", "none", []string{"同意", "其他"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := QuestionPolicy(tc.kind, tc.options)
			if p.Input != tc.input || p.Validate() != nil {
				t.Fatalf("unexpected policy: %+v", p)
			}
			if tc.input == "none" && p.MaxFollowups != 0 || tc.input != "none" && p.MaxFollowups != 2 {
				t.Fatalf("unexpected ceiling: %+v", p)
			}
		})
	}
}

func TestConditionalOtherRequiresSelectedOptionAndWrittenText(t *testing.T) {
	p := QuestionPolicy("单项选择", []string{"标准选项", "其他"})
	q := Question{ID: "Q1", FollowupPolicy: &p}
	text, blank := "一个真实例子", "  "
	for _, tc := range []struct {
		name string
		a    Answer
		want bool
	}{
		{"other text", Answer{TextInput: &text, SelectedOptions: []string{"其他"}}, true},
		{"not selected", Answer{TextInput: &text, SelectedOptions: []string{"标准选项"}}, false},
		{"empty", Answer{TextInput: &blank, SelectedOptions: []string{"其他"}}, false},
		{"missing", Answer{SelectedOptions: []string{"其他"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if FollowupTextEligible(q, tc.a) != tc.want {
				t.Fatal("unexpected text eligibility")
			}
		})
	}
	if !FollowupTextEligible(Question{ID: "legacy"}, Answer{Text: "existing frozen answer"}) {
		t.Fatal("legacy session behavior changed")
	}
}

func TestNewPolicyCapsNewSessionsWithoutChangingHistoricalValues(t *testing.T) {
	old := 3
	original := FollowupPolicy{Scope: "interview", MaxFollowups: &old}
	fresh := NewInterviewPolicy(&original)
	if fresh.Scope != "interview" || *fresh.MaxFollowups != 2 || *original.MaxFollowups != 3 {
		t.Fatal("policy normalization mutated history")
	}
	if *NewInterviewPolicy(nil).MaxFollowups != 2 {
		t.Fatal("missing built-in default")
	}
	for _, n := range []int{0, 1, 2} {
		p := NewInterviewPolicy(&FollowupPolicy{Scope: "per_question", MaxFollowups: &n})
		if *p.MaxFollowups != n {
			t.Fatal("explicit lower limit lost")
		}
	}
	snapshot := Snapshot{Pack: &PackContext{Policy: original}}
	_, historicalLimit := FollowupLimit(snapshot, nil, "Q1", 7)
	if historicalLimit != 3 {
		t.Fatal("historical frozen limit changed")
	}
	qPolicy := QuestionPolicy("开放回忆", nil)
	snapshot.Questions = []Question{{ID: "Q1", FollowupPolicy: &qPolicy}}
	count, limit := FollowupLimit(snapshot, []Followup{{QuestionID: "Q1"}, {QuestionID: "Q2"}}, "Q1", 7)
	if count != 2 || limit != 2 {
		t.Fatal("interview or per-question ceiling bypassed")
	}
}
