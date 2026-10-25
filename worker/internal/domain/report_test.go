package domain

import "testing"

func TestReportIssuesLocateEmptyAndInvalidReferences(t *testing.T) {
	evidence := EvidenceResult{Evidence: []Evidence{{ID: "E1"}}}
	report := Report{Title: "合成", Sections: []Section{{Title: "合成事实", Statements: []Statement{{Kind: "fact", Text: "合成事实", EvidenceIDs: []string{}}}}}, TaskCards: []TaskCard{{Title: "合成任务", EvidenceIDs: []string{"UNKNOWN"}}}}
	issues := ReportIssues(report, evidence)
	if len(issues) != 2 || issues[0].Path != "sections[0].statements[0].evidence_ids" || issues[1].Rule != "citation_not_in_supplied_evidence" {
		t.Fatalf("wrong diagnostic fields: %v", issues)
	}
	report.Sections[0].Statements[0].EvidenceIDs = []string{"E1", "E1"}
	if ValidateReport(report, evidence) == nil {
		t.Fatal("duplicate/unknown references accepted")
	}
}
func TestZeroEvidenceRejectsInterpretationAndTaskCards(t *testing.T) {
	report := Report{Title: "合成", Sections: []Section{{Title: "合成", Statements: []Statement{{Kind: "interpretation", Text: "无证据推断", EvidenceIDs: []string{}}}}}}
	if ValidateReport(report, EvidenceResult{}) == nil {
		t.Fatal("unfounded interpretation accepted")
	}
	report.Sections[0].Statements[0].Kind = "needs_verification"
	if err := ValidateReport(report, EvidenceResult{}); err != nil {
		t.Fatal(err)
	}
	report.TaskCards = []TaskCard{{Title: "无证据任务", EvidenceIDs: []string{}}}
	if ValidateReport(report, EvidenceResult{}) == nil {
		t.Fatal("unfounded task card accepted")
	}
}
