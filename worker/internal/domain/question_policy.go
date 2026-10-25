package domain

import (
	"regexp"
	"strconv"
	"strings"
)

const MaxQuestionFollowups = 2

// QuestionFollowupPolicy retains published input metadata and its per-question ceiling.
type QuestionFollowupPolicy struct {
	Input        string   `json:"input"`
	MaxFollowups int      `json:"maxFollowups"`
	OtherOptions []string `json:"otherOptions,omitempty"`
}

var choiceType = regexp.MustCompile(`选择|单选|多选|choice|radio|checkbox`)
var otherOption = regexp.MustCompile(`(?i)^(其他|其它|other)($|[\s\p{Z}:：（(])`)

// ExplicitQuestionPolicy validates new answer modes without reinterpreting legacy packs.
func ExplicitQuestionPolicy(mode, kind string, options []string) (QuestionFollowupPolicy, error) {
	if mode == "" {
		return QuestionPolicy(kind, options), nil
	}
	bad := func() (QuestionFollowupPolicy, error) {
		return QuestionFollowupPolicy{}, Fail("INVALID_ANSWER_MODE", 400)
	}
	if mode == "text" {
		if len(options) != 0 {
			return bad()
		}
		return QuestionFollowupPolicy{Input: "text", MaxFollowups: MaxQuestionFollowups}, nil
	}
	if len(options) == 0 {
		return bad()
	}
	switch mode {
	case "choice":
		return QuestionFollowupPolicy{Input: "none"}, nil
	case "mixed":
		return QuestionFollowupPolicy{Input: "text", MaxFollowups: MaxQuestionFollowups}, nil
	case "other":
		var other []string
		for _, option := range options {
			if otherOption.MatchString(strings.TrimSpace(option)) {
				other = append(other, option)
			}
		}
		if len(other) == 0 {
			return bad()
		}
		return QuestionFollowupPolicy{Input: "other", MaxFollowups: MaxQuestionFollowups, OtherOptions: other}, nil
	default:
		return bad()
	}
}

// QuestionPolicy follows the participant controls; consent never has a text input.
func QuestionPolicy(kind string, options []string) QuestionFollowupPolicy {
	kind = strings.ToLower(strings.TrimSpace(kind))
	if strings.Contains(kind, "授权") || strings.Contains(kind, "consent") {
		return QuestionFollowupPolicy{Input: "none"}
	}
	if len(options) > 0 || choiceType.MatchString(kind) {
		var other []string
		for _, option := range options {
			if otherOption.MatchString(strings.TrimSpace(option)) {
				other = append(other, option)
			}
		}
		if len(other) > 0 {
			return QuestionFollowupPolicy{Input: "other", MaxFollowups: MaxQuestionFollowups, OtherOptions: other}
		}
		return QuestionFollowupPolicy{Input: "none"}
	}
	return QuestionFollowupPolicy{Input: "text", MaxFollowups: MaxQuestionFollowups}
}

func (p QuestionFollowupPolicy) Validate() error {
	if p.MaxFollowups < 0 || p.MaxFollowups > MaxQuestionFollowups || len(p.OtherOptions) > 100 {
		return Fail("INVALID_QUESTION_POLICY", 400)
	}
	switch p.Input {
	case "none":
		if p.MaxFollowups != 0 || len(p.OtherOptions) != 0 {
			return Fail("INVALID_QUESTION_POLICY", 400)
		}
	case "text":
		if len(p.OtherOptions) != 0 {
			return Fail("INVALID_QUESTION_POLICY", 400)
		}
	case "other":
		if len(p.OtherOptions) == 0 {
			return Fail("INVALID_QUESTION_POLICY", 400)
		}
	default:
		return Fail("INVALID_QUESTION_POLICY", 400)
	}
	seen := map[string]bool{}
	for _, option := range p.OtherOptions {
		if strings.TrimSpace(option) == "" || len(option) > 2000 || seen[option] {
			return Fail("INVALID_QUESTION_POLICY", 400)
		}
		seen[option] = true
	}
	return nil
}

// NewInterviewPolicy caps new sessions without rewriting already-frozen policies.
func NewInterviewPolicy(original *FollowupPolicy) *FollowupPolicy {
	limit, scope := MaxQuestionFollowups, "per_question"
	if original != nil {
		scope = original.Scope
		if original.MaxFollowups != nil && *original.MaxFollowups < limit {
			limit = *original.MaxFollowups
		}
	}
	return &FollowupPolicy{Scope: scope, MaxFollowups: &limit}
}

// FollowupTextEligible accepts actual narrative text independently of legacy option gates.
// Frozen per-question and interview ceilings remain enforced by FollowupLimit.
func FollowupTextEligible(q Question, a Answer) bool {
	if q.FollowupPolicy == nil {
		return true // Existing frozen interviews retain their published behavior.
	}
	if a.TextInput == nil || strings.TrimSpace(*a.TextInput) == "" {
		return false
	}
	return true
}

// StructuredAnswerText is the evidence text preserved alongside editable answer fields.
func StructuredAnswerText(a Answer) string {
	parts := []string{}
	if len(a.SelectedOptions) > 0 {
		parts = append(parts, "选择："+strings.Join(a.SelectedOptions, "；"))
	}
	if a.TextInput != nil && *a.TextInput != "" {
		parts = append(parts, *a.TextInput)
	}
	for i, text := range a.Supplements {
		parts = append(parts, "补充回答 "+strconv.Itoa(i+1)+"："+text)
	}
	return strings.Join(parts, "\n")
}
