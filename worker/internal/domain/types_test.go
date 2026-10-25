package domain

import (
	"encoding/json"
	"testing"
)

func TestDecodeRejectsDuplicateFieldsAndSlotlessAnalysisIsAccepted(t *testing.T) {
	var result Analysis
	if err := Decode([]byte(`{"status":"complete","reason":"回答充分"}`), &result); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAnalysis(result, Question{}); err != nil {
		t.Fatal(err)
	}
	var value any
	for _, raw := range []string{`{"scope":"per_question","scope":"interview"}`, `{"questions":[{"id":"Q01","id":"Q02"}]}`} {
		if Decode([]byte(raw), &value) == nil {
			t.Fatal("duplicate field accepted")
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"status":"complete","reason":"回答充分"}` {
		t.Fatal("slotless output gained required fields")
	}
}

func TestEvidenceMustMatchOriginalAnswers(t *testing.T) {
	in := Snapshot{Answers: []Answer{{QuestionID: "q", Text: "验收记录", Confirmed: true}}}
	cases := []struct {
		name   string
		result EvidenceResult
	}{
		{"invented quote", EvidenceResult{Evidence: []Evidence{{ID: "e", QuestionID: "q", Quote: "口头确认"}}}},
		{"unknown question", EvidenceResult{Evidence: []Evidence{{ID: "e", QuestionID: "other", Quote: "验收记录"}}}},
		{"duplicate identity", EvidenceResult{Evidence: []Evidence{{ID: "e", QuestionID: "q", Quote: "验收记录"}, {ID: "e", QuestionID: "q", Quote: "验收记录"}}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if ValidateEvidence(c.result, in) == nil {
				t.Fatal("invalid evidence accepted")
			}
		})
	}
	in.Answers[0].Skipped = true
	if ValidateEvidence(EvidenceResult{Evidence: []Evidence{{ID: "e", QuestionID: "q", Quote: "验收记录"}}}, in) == nil {
		t.Fatal("skipped answer treated as evidence")
	}
}
func TestFactsAndTaskCardsRequireKnownCitations(t *testing.T) {
	evidence := EvidenceResult{Evidence: []Evidence{{ID: "e"}}}
	report := Report{Title: "报告", Sections: []Section{{Title: "摘要", Statements: []Statement{{Kind: "fact", Text: "质量经过验收"}}}}}
	if ValidateReport(report, evidence) == nil {
		t.Fatal("uncited fact accepted")
	}
	report.Sections[0].Statements[0].EvidenceIDs = []string{"unknown"}
	if ValidateReport(report, evidence) == nil {
		t.Fatal("unknown citation accepted")
	}
	report.Sections[0].Statements[0].EvidenceIDs = []string{"e"}
	report.TaskCards = []TaskCard{{Title: "任务"}}
	if ValidateReport(report, evidence) == nil {
		t.Fatal("uncited card accepted")
	}
	report.TaskCards[0].EvidenceIDs = []string{"e"}
	if err := ValidateReport(report, evidence); err != nil {
		t.Fatal(err)
	}
}
func TestAnalysisCannotInventRequiredSlots(t *testing.T) {
	q := Question{RequiredSlots: []string{"evidence"}}
	if ValidateAnalysis(Analysis{Status: "incomplete", MissingSlots: []string{"other"}}, q) == nil {
		t.Fatal("invented slot accepted")
	}
	if ValidateAnalysis(Analysis{Status: "complete", MissingSlots: []string{"evidence"}}, q) == nil {
		t.Fatal("contradictory completeness accepted")
	}
}
