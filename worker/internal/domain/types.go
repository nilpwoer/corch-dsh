// Package domain 定义 Worker 输入、输出和确定性校验，不依赖 HTTP 或数据库。
package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

type Question struct {
	ID             string                  `json:"id"`
	Text           string                  `json:"text"`
	RequiredSlots  []string                `json:"required_slots"`
	FollowUp       string                  `json:"followUp,omitempty"`
	SourceRefs     json.RawMessage         `json:"sourceRefs,omitempty"`
	FollowupPolicy *QuestionFollowupPolicy `json:"followup_policy,omitempty"`
	Options        []string                `json:"options,omitempty"`
}
type Answer struct {
	QuestionID      string   `json:"question_id"`
	Text            string   `json:"text"`
	Skipped         bool     `json:"skipped"`
	Confirmed       bool     `json:"confirmed"`
	TextInput       *string  `json:"text_input,omitempty"`
	SelectedOptions []string `json:"selected_options,omitempty"`
	Supplements     []string `json:"supplements,omitempty"`
}
type Profile struct {
	Name       string `json:"name"`
	Industry   string `json:"industry"`
	Role       string `json:"role"`
	Stage      string `json:"stage"`
	Experience string `json:"experience"`
	Years      string `json:"years,omitempty"`
}

// Snapshot 的版本由调用方单调递增；同版本不能对应不同内容。
type Snapshot struct {
	InterviewID         string       `json:"interview_id"`
	InputVersion        int64        `json:"input_version"`
	QuestionPackVersion int64        `json:"question_pack_version"`
	Profile             Profile      `json:"profile"`
	Questions           []Question   `json:"questions"`
	Answers             []Answer     `json:"answers"`
	Pack                *PackContext `json:"pack,omitempty"`
}

// FollowupPolicy is explicit package-owned policy; a missing count is distinct from zero.
type FollowupPolicy struct {
	Scope        string `json:"scope"`
	MaxFollowups *int   `json:"maxFollowups"`
}

func (p FollowupPolicy) Validate() error {
	if (p.Scope != "per_question" && p.Scope != "interview") || p.MaxFollowups == nil || *p.MaxFollowups < 0 {
		return Fail("INVALID_FOLLOWUP_POLICY", 400)
	}
	return nil
}

type PackContext struct {
	Key    string         `json:"key"`
	PackID string         `json:"packId"`
	Hash   string         `json:"hash"`
	Goal   string         `json:"goal"`
	Policy FollowupPolicy `json:"policy"`
}

// FollowupLimit counts published questions, not failed model requests or retries.
func FollowupLimit(in Snapshot, history []Followup, questionID string, legacyLimit int) (int, int) {
	limit, scope := legacyLimit, "per_question"
	if in.Pack != nil {
		limit = *in.Pack.Policy.MaxFollowups
		scope = in.Pack.Policy.Scope
	}
	for _, q := range in.Questions {
		if q.ID == questionID && q.FollowupPolicy != nil && q.FollowupPolicy.MaxFollowups < limit {
			limit = q.FollowupPolicy.MaxFollowups
		}
	}
	count := 0
	for _, f := range history {
		if scope == "interview" || f.QuestionID == questionID {
			count++
		}
	}
	return count, limit
}

type Submit struct {
	Kind       string   `json:"kind"`
	QuestionID string   `json:"question_id,omitempty"`
	Snapshot   Snapshot `json:"snapshot"`
}
type Followup struct {
	QuestionID   string `json:"question_id"`
	InputVersion int64  `json:"input_version"`
	Text         string `json:"text"`
}
type Analysis struct {
	Status       string   `json:"status"`
	CoveredSlots []string `json:"covered_slots,omitempty"`
	MissingSlots []string `json:"missing_slots,omitempty"`
	Reason       string   `json:"reason"`
}
type FollowupResult struct {
	Status    string    `json:"status"`
	Analysis  *Analysis `json:"analysis,omitempty"`
	Text      string    `json:"text,omitempty"`
	AllowSkip bool      `json:"allow_skip"`
	Reason    string    `json:"reason,omitempty"`
}
type Evidence struct {
	ID         string `json:"id"`
	QuestionID string `json:"question_id"`
	Quote      string `json:"quote"`
}
type EvidenceResult struct {
	Evidence []Evidence `json:"evidence"`
}
type Statement struct {
	Kind        string   `json:"kind"`
	Text        string   `json:"text"`
	EvidenceIDs []string `json:"evidence_ids"`
}
type Section struct {
	Title      string      `json:"title"`
	Statements []Statement `json:"statements"`
}
type TaskCard struct {
	Title           string   `json:"title"`
	Trigger         string   `json:"trigger"`
	Context         string   `json:"context"`
	Steps           []string `json:"steps"`
	Judgments       []string `json:"judgments"`
	Tools           []string `json:"tools"`
	Collaboration   string   `json:"collaboration"`
	QualityEvidence string   `json:"quality_evidence"`
	Boundaries      string   `json:"boundaries"`
	EvidenceIDs     []string `json:"evidence_ids"`
}
type Report struct {
	Title             string     `json:"title"`
	Sections          []Section  `json:"sections"`
	TaskCards         []TaskCard `json:"task_cards"`
	NeedsVerification []string   `json:"needs_verification"`
}
type ReportResult struct {
	ReportVersion int64      `json:"report_version"`
	InputVersion  int64      `json:"input_version"`
	Report        Report     `json:"report"`
	Evidence      []Evidence `json:"evidence"`
}

type Error struct {
	Code       string
	HTTPStatus int
	Retryable  bool
}

func (e *Error) Error() string           { return e.Code }
func Fail(code string, status int) error { return &Error{Code: code, HTTPStatus: status} }

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func (s Submit) Validate() error {
	bad := func() error { return Fail("INVALID_INPUT", 400) }
	if s.Kind != "followup" && s.Kind != "report" {
		return bad()
	}
	in := s.Snapshot
	if in.Pack != nil {
		if err := in.Pack.Policy.Validate(); err != nil {
			return err
		}
		if !identifier.MatchString(in.Pack.Key) || len(in.Pack.Hash) != 64 || strings.TrimSpace(in.Pack.PackID) == "" {
			return bad()
		}
	}
	if !identifier.MatchString(in.InterviewID) || in.InputVersion < 1 || in.QuestionPackVersion < 1 || len(in.Questions) < 1 || len(in.Questions) > 100 {
		return bad()
	}
	seen := map[string]bool{}
	questions := map[string]Question{}
	for _, q := range in.Questions {
		if !identifier.MatchString(q.ID) || seen[q.ID] || strings.TrimSpace(q.Text) == "" || len(q.Text) > 30000 || len(q.RequiredSlots) > 30 {
			return bad()
		}
		seen[q.ID] = true
		questions[q.ID] = q
		if q.FollowupPolicy != nil && q.FollowupPolicy.Validate() != nil {
			return bad()
		}
		slots := map[string]bool{}
		for _, slot := range q.RequiredSlots {
			if slot == "" || len(slot) > 100 || slots[slot] {
				return bad()
			}
			slots[slot] = true
		}
	}
	answers := map[string]Answer{}
	for _, a := range in.Answers {
		if !seen[a.QuestionID] || len(a.Text) > 300000 {
			return bad()
		}
		if _, ok := answers[a.QuestionID]; ok {
			return bad()
		}
		answers[a.QuestionID] = a
		if q := questions[a.QuestionID]; q.FollowupPolicy != nil {
			if a.TextInput == nil || len(*a.TextInput) > 60000 || len(a.Supplements) > MaxQuestionFollowups || a.Text != StructuredAnswerText(a) {
				return bad()
			}
			allowed, selected := map[string]bool{}, map[string]bool{}
			for _, option := range q.Options {
				allowed[option] = true
			}
			for _, option := range a.SelectedOptions {
				if !allowed[option] || selected[option] {
					return bad()
				}
				selected[option] = true
			}
			for _, text := range a.Supplements {
				if len(text) > 30000 {
					return bad()
				}
			}
			if q.FollowupPolicy.Input == "none" && *a.TextInput != "" {
				return bad()
			}
		}
		if a.Confirmed && !a.Skipped && strings.TrimSpace(a.Text) == "" {
			return bad()
		}
	}
	if s.Kind == "followup" {
		a, ok := answers[s.QuestionID]
		if !seen[s.QuestionID] || !ok || !a.Confirmed {
			return bad()
		}
	} else {
		if s.QuestionID != "" {
			return bad()
		}
		for id := range seen {
			if !answers[id].Confirmed {
				return Fail("ANSWERS_NOT_CONFIRMED", 409)
			}
		}
	}
	return nil
}

// Decode 拒绝未知或重复字段、多段 JSON、尾随内容和过深嵌套。
func Decode(data []byte, dest any) error {
	check := json.NewDecoder(bytes.NewReader(data))
	if err := uniqueFields(check, 0); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(dest); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("JSON 必须恰好包含一个值")
	}
	return nil
}

func uniqueFields(d *json.Decoder, depth int) error {
	if depth > 256 {
		return fmt.Errorf("JSON nesting is too deep")
	}
	token, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if delim == '{' {
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name := key.(string)
			if seen[name] {
				return fmt.Errorf("duplicate JSON field")
			}
			seen[name] = true
			if err := uniqueFields(d, depth+1); err != nil {
				return err
			}
		}
	} else if delim == '[' {
		for d.More() {
			if err := uniqueFields(d, depth+1); err != nil {
				return err
			}
		}
	}
	_, err = d.Token()
	return err
}

func ValidateAnalysis(a Analysis, q Question) error {
	if a.Status != "complete" && a.Status != "incomplete" && a.Status != "uncertain" && a.Status != "sensitive" {
		return Fail("INVALID_ANALYSIS", 422)
	}
	allowed := map[string]bool{}
	for _, s := range q.RequiredSlots {
		allowed[s] = true
	}
	seen := map[string]bool{}
	for _, group := range [][]string{a.CoveredSlots, a.MissingSlots} {
		for _, slot := range group {
			if !allowed[slot] || seen[slot] {
				return Fail("INVALID_ANALYSIS", 422)
			}
			seen[slot] = true
		}
	}
	if len(a.Reason) > 10000 || a.Status == "complete" && len(a.MissingSlots) > 0 {
		return Fail("INVALID_ANALYSIS", 422)
	}
	return nil
}
func ValidateEvidence(e EvidenceResult, in Snapshot) error {
	if len(e.Evidence) > 500 {
		return Fail("INVALID_EVIDENCE", 422)
	}
	answers := map[string]Answer{}
	for _, a := range in.Answers {
		answers[a.QuestionID] = a
	}
	ids := map[string]bool{}
	for _, item := range e.Evidence {
		a, ok := answers[item.QuestionID]
		if !identifier.MatchString(item.ID) || ids[item.ID] || !ok || a.Skipped || item.Quote == "" || len(item.Quote) > 30000 || !strings.Contains(a.Text, item.Quote) {
			return Fail("INVALID_EVIDENCE", 422)
		}
		ids[item.ID] = true
	}
	return nil
}
func ValidateReport(r Report, e EvidenceResult) error {
	if len(ReportIssues(r, e)) > 0 {
		return Fail("INVALID_REPORT_CITATION", 422)
	}
	return nil
}
