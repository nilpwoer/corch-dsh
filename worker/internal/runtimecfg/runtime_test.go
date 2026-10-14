package runtimecfg

import (
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"testing"
)

func count(n int) *int { return &n }

func TestResolveFreezesModelsAndLayeredBusinessPrompts(t *testing.T) {
	c, err := config.Load("../../config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	global := Settings{Followup: &Prompts{Analyze: "global analysis", Compose: "global composition"}, Report: &Prompts{Analyze: "global report", Compose: "global report composition"}}
	pack := Settings{Report: &Prompts{Analyze: "pack report", Compose: "pack composition"}, Policy: &domain.FollowupPolicy{Scope: "interview", MaxFollowups: count(0)}}
	f := Resolve(c, global, pack, &domain.FollowupPolicy{Scope: "per_question", MaxFollowups: count(2)})
	if !f.Valid() || f.Followup.Pipeline.Analyze != "global analysis" || f.Report.Pipeline.Analyze != "pack report" || *f.Policy.MaxFollowups != 0 || f.Policy.Scope != "interview" {
		t.Fatal("inheritance or freeze invalid")
	}
	if config.Hash(f.Report.Pipeline.Model) != config.Hash(c.Prompts["report"].Model) || f.Report.Provider.APIKey != "" {
		t.Fatal("model changed or credential persisted")
	}
	changed := c.Prompts["report"]
	changed.Model.Name = "changed-after-start"
	c.Prompts["report"] = changed
	if f.Report.Pipeline.Model.Name == changed.Model.Name {
		t.Fatal("frozen model changed")
	}
	*pack.Policy.MaxFollowups = 7
	if c.Prompts["report"].Model.Temperature != nil {
		*c.Prompts["report"].Model.Temperature = 9
	}
	if !f.Valid() || *f.Policy.MaxFollowups != 0 {
		t.Fatal("frozen runtime retained mutable input pointers")
	}
	f.Report.Pipeline.Analyze = "tampered"
	if f.Valid() {
		t.Fatal("modified frozen prompt accepted")
	}
}

func TestEditableSettingsRejectIncompleteOrOversizedPipelines(t *testing.T) {
	for _, value := range []Settings{{Followup: &Prompts{Analyze: "", Compose: "valid"}}, {Policy: &domain.FollowupPolicy{Scope: "invalid", MaxFollowups: count(1)}}} {
		if value.Validate(false) == nil {
			t.Fatal("invalid settings accepted")
		}
	}
	if (Settings{Policy: &domain.FollowupPolicy{Scope: "interview", MaxFollowups: count(1)}}).Validate(true) == nil {
		t.Fatal("global package policy accepted")
	}
}
