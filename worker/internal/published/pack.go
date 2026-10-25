// Package published parses DSH publications separately from engine snapshots.
package published

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

type SourceRef struct {
	SourceType           string `json:"sourceType"`
	Title                string `json:"title"`
	Locator              string `json:"locator,omitempty"`
	Excerpt              string `json:"excerpt,omitempty"`
	Rationale            string `json:"rationale,omitempty"`
	Confidence           string `json:"confidence,omitempty"`
	RequiresConfirmation bool   `json:"requiresConfirmation,omitempty"`
}
type Question struct {
	ID             string                         `json:"id"`
	Title          string                         `json:"title"`
	Type           string                         `json:"type"`
	AnswerMode     *string                        `json:"answerMode,omitempty"`
	Question       string                         `json:"question"`
	Helper         string                         `json:"helper,omitempty"`
	FollowUp       string                         `json:"followUp,omitempty"`
	Options        []string                       `json:"options,omitempty"`
	SourceRefs     []SourceRef                    `json:"sourceRefs,omitempty"`
	RequiredSlots  []string                       `json:"required_slots,omitempty"`
	FollowupPolicy *domain.QuestionFollowupPolicy `json:"followupPolicy,omitempty"`
}
type Profile struct {
	Name       string          `json:"name"`
	Industry   string          `json:"industry"`
	Role       string          `json:"role"`
	Years      string          `json:"years,omitempty"`
	Stage      string          `json:"stage"`
	Experience string          `json:"experience"`
	Materials  json.RawMessage `json:"materials,omitempty"`
}
type Meta struct {
	PackID           string          `json:"packId,omitempty"`
	Version          int64           `json:"version"`
	GeneratedAt      string          `json:"generatedAt,omitempty"`
	SourceSessionID  string          `json:"sourceSessionId,omitempty"`
	Checksum         string          `json:"checksum,omitempty"`
	GlobalReferences json.RawMessage `json:"globalReferences,omitempty"`
}
type Invitation struct {
	Code      string `json:"code"`
	CreatedAt string `json:"createdAt"`
	Status    string `json:"status"`
}

// Pack retains host publication data; it must never be sent directly to a participant.
type Pack struct {
	SchemaVersion     int                    `json:"schemaVersion,omitempty"`
	FieldnoteID       string                 `json:"fieldnoteId"`
	PublicFieldnoteID string                 `json:"publicFieldnoteId,omitempty"`
	Goal              string                 `json:"goal,omitempty"`
	Profile           Profile                `json:"profile"`
	Questions         []Question             `json:"questions"`
	Meta              Meta                   `json:"questionPackMeta"`
	Invitation        *Invitation            `json:"invitation,omitempty"`
	PublishedAt       string                 `json:"publishedAt,omitempty"`
	Policy            *domain.FollowupPolicy `json:"interviewPolicy,omitempty"`
}

var safeKey = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

// ValidKey accepts one URL-safe identifier, never a path or an encoded path.
func ValidKey(key string) bool { return safeKey.MatchString(key) }

// Parse accepts legacy DSH publications without slots and rejects ambiguous or unsupported input.
func Parse(raw []byte) (Pack, string, error) {
	var p Pack
	if err := domain.Decode(raw, &p); err != nil {
		return p, "", fmt.Errorf("invalid published JSON: %w", err)
	}
	if p.SchemaVersion < 0 || p.SchemaVersion > 1 {
		return p, "", fmt.Errorf("unsupported publication schema")
	}
	if strings.TrimSpace(p.FieldnoteID) == "" || len(p.FieldnoteID) > 300 || strings.ContainsAny(p.FieldnoteID, "/\\\x00") || p.Meta.Version < 1 || len(p.Questions) < 1 || len(p.Questions) > 100 {
		return p, "", fmt.Errorf("invalid publication identity, version or question count")
	}
	if p.PublicFieldnoteID != "" && !ValidKey(p.PublicFieldnoteID) {
		return p, "", fmt.Errorf("invalid public fieldnote identifier")
	}
	seen := map[string]bool{}
	if p.Invitation != nil && len(p.Invitation.Code) > 128 {
		return p, "", fmt.Errorf("invalid invitation length")
	}
	if p.Policy != nil {
		if err := p.Policy.Validate(); err != nil {
			return p, "", err
		}
	}
	for _, q := range p.Questions {
		if !ValidKey(q.ID) || seen[q.ID] || strings.TrimSpace(q.Question) == "" || len(q.Question) > 30000 {
			return p, "", fmt.Errorf("invalid or duplicate published question")
		}
		seen[q.ID] = true
		mode := ""
		if q.AnswerMode != nil {
			mode = *q.AnswerMode
			if mode == "" {
				return p, "", domain.Fail("INVALID_ANSWER_MODE", 400)
			}
		}
		expected, modeErr := domain.ExplicitQuestionPolicy(mode, q.Type, q.Options)
		if modeErr != nil {
			return p, "", modeErr
		}
		if q.AnswerMode != nil && q.FollowupPolicy == nil {
			return p, "", domain.Fail("QUESTION_INPUT_POLICY_MISMATCH", 400)
		}
		if q.FollowupPolicy != nil {
			if err := q.FollowupPolicy.Validate(); err != nil {
				return p, "", err
			}
			if q.FollowupPolicy.Input != expected.Input || configPolicyOptions(q.FollowupPolicy.OtherOptions) != configPolicyOptions(expected.OtherOptions) {
				return p, "", domain.Fail("QUESTION_INPUT_POLICY_MISMATCH", 400)
			}
		}
	}
	// Hash the complete JSON, including metadata and policy, independently of formatting and object key order.
	var value any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if err := d.Decode(&value); err != nil {
		return p, "", err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return p, "", err
	}
	sum := sha256.Sum256(canonical)
	return p, hex.EncodeToString(sum[:]), nil
}

// ParticipantView excludes invitation codes and host materials from browser payloads.
func (p Pack) ParticipantView() any {
	return struct {
		FieldnoteID string         `json:"fieldnoteId"`
		Profile     domain.Profile `json:"profile"`
		Questions   []Question     `json:"questions"`
		Meta        Meta           `json:"questionPackMeta"`
	}{p.FieldnoteID, domain.Profile{Name: p.Profile.Name, Industry: p.Profile.Industry, Role: p.Profile.Role, Stage: p.Profile.Stage, Experience: p.Profile.Experience, Years: p.Profile.Years}, p.Questions, p.Meta}
}

// Snapshot maps a fixed publication into worker input without imposing required slots.
func (e Entry) Snapshot(id string) (domain.Snapshot, error) {
	if strings.TrimSpace(e.Pack.Goal) == "" {
		return domain.Snapshot{}, domain.Fail("INTERVIEW_GOAL_REQUIRED", 409)
	}
	if e.Pack.Policy == nil {
		return domain.Snapshot{}, domain.Fail("FOLLOWUP_POLICY_REQUIRED", 409)
	}
	packID := e.Pack.Meta.PackID
	if packID == "" {
		packID = e.Pack.FieldnoteID
	}
	p := e.Pack.Profile
	// Never expose a fast digest containing a short invitation code: it can enable offline guessing.
	publicBinding := e.Pack
	publicBinding.Invitation = nil
	raw, err := json.Marshal(publicBinding)
	if err != nil {
		return domain.Snapshot{}, err
	}
	_, runtimeHash, err := Parse(raw)
	if err != nil {
		return domain.Snapshot{}, err
	}
	in := domain.Snapshot{InterviewID: id, InputVersion: 1, QuestionPackVersion: e.Pack.Meta.Version, Profile: domain.Profile{Name: p.Name, Industry: p.Industry, Role: p.Role, Stage: p.Stage, Experience: p.Experience, Years: p.Years}, Pack: &domain.PackContext{Key: e.Key, PackID: packID, Hash: runtimeHash, Goal: e.Pack.Goal, Policy: *e.Pack.Policy}}
	for _, q := range e.Pack.Questions {
		refs, err := json.Marshal(q.SourceRefs)
		if err != nil {
			return in, err
		}
		question := domain.Question{ID: q.ID, Text: q.Question, FollowUp: q.FollowUp, SourceRefs: refs, FollowupPolicy: q.FollowupPolicy}
		if q.FollowupPolicy != nil {
			question.Options = q.Options
		}
		in.Questions = append(in.Questions, question)
	}
	return in, nil
}

func configPolicyOptions(values []string) string {
	raw, _ := json.Marshal(values)
	if len(values) == 0 {
		return "[]"
	}
	return string(raw)
}

// NewInterviewCopy fills answer controls only for new sessions; saved sessions stay immutable.
func (p Pack) NewInterviewCopy() Pack {
	p.Questions = append([]Question(nil), p.Questions...)
	for i := range p.Questions {
		if p.Questions[i].FollowupPolicy == nil {
			policy := domain.QuestionPolicy(p.Questions[i].Type, p.Questions[i].Options)
			p.Questions[i].FollowupPolicy = &policy
		}
	}
	return p
}
