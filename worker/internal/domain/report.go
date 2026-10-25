package domain

import (
	"fmt"
	"strings"
)

// ReportContext carries verified answer evidence; profile and question-design sources are not answer evidence.
type ReportContext struct {
	Profile   Profile      `json:"profile"`
	Evidence  []Evidence   `json:"evidence"`
	Followups []Followup   `json:"followups"`
	Pack      *PackContext `json:"pack,omitempty"`
}

// ReportIssue identifies an invalid field without copying statement or answer text.
type ReportIssue struct {
	Path string `json:"path"`
	Rule string `json:"rule"`
}

// ReportIssues enforces report structure, known citations and the zero-evidence policy.
func ReportIssues(r Report, e EvidenceResult) []ReportIssue {
	issues := []ReportIssue{}
	add := func(path, rule string) { issues = append(issues, ReportIssue{path, rule}) }
	ids := map[string]bool{}
	for _, item := range e.Evidence {
		ids[item.ID] = true
	}
	refs := func(path string, cites []string, required bool) {
		if required && len(cites) == 0 {
			add(path, "citation_required")
		}
		if len(cites) > 100 {
			add(path, "too_many_citations")
		}
		seen := map[string]bool{}
		for _, id := range cites {
			if !ids[id] {
				add(path, "citation_not_in_supplied_evidence")
			}
			if seen[id] {
				add(path, "duplicate_citation")
			}
			seen[id] = true
		}
	}
	if strings.TrimSpace(r.Title) == "" || len(r.Title) > 1500 {
		add("title", "invalid_title")
	}
	if len(r.Sections) < 1 || len(r.Sections) > 30 {
		add("sections", "invalid_section_count")
	}
	if len(r.TaskCards) > 100 {
		add("task_cards", "too_many_task_cards")
	}
	if len(e.Evidence) == 0 && len(r.TaskCards) > 0 {
		add("task_cards", "no_task_cards_without_evidence")
	}
	if len(r.NeedsVerification) > 100 {
		add("needs_verification", "too_many_items")
	}
	for i, s := range r.Sections {
		path := fmt.Sprintf("sections[%d]", i)
		if strings.TrimSpace(s.Title) == "" {
			add(path+".title", "section_title_required")
		}
		if len(s.Statements) > 100 {
			add(path+".statements", "too_many_statements")
		}
		for j, st := range s.Statements {
			p := fmt.Sprintf("%s.statements[%d]", path, j)
			if st.Kind != "fact" && st.Kind != "interpretation" && st.Kind != "needs_verification" {
				add(p+".kind", "invalid_statement_kind")
			}
			if len(e.Evidence) == 0 && st.Kind != "needs_verification" {
				add(p+".kind", "only_needs_verification_without_evidence")
			}
			if strings.TrimSpace(st.Text) == "" {
				add(p+".text", "statement_text_required")
			}
			refs(p+".evidence_ids", st.EvidenceIDs, st.Kind == "fact")
		}
	}
	for i, card := range r.TaskCards {
		p := fmt.Sprintf("task_cards[%d]", i)
		if strings.TrimSpace(card.Title) == "" {
			add(p+".title", "task_title_required")
		}
		refs(p+".evidence_ids", card.EvidenceIDs, true)
	}
	return issues
}
