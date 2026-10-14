// Package runtimecfg resolves editable business prompts into immutable execution data.
package runtimecfg

import (
	"strings"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

// Prompts excludes models, providers and all non-editable output/citation constraints.
type Prompts struct {
	Analyze string `json:"analyze"`
	Compose string `json:"compose"`
}

// Settings uses nil for inheritance; a pipeline override replaces both business prompts.
type Settings struct {
	Followup *Prompts               `json:"followup,omitempty"`
	Report   *Prompts               `json:"report,omitempty"`
	Policy   *domain.FollowupPolicy `json:"policy,omitempty"`
}

func (s Settings) Validate(global bool) error {
	if global && s.Policy != nil {
		return domain.Fail("PACK_POLICY_REQUIRED", 400)
	}
	if s.Policy != nil {
		if err := s.Policy.Validate(); err != nil {
			return err
		}
	}
	for _, p := range []*Prompts{s.Followup, s.Report} {
		if p != nil && (strings.TrimSpace(p.Analyze) == "" || strings.TrimSpace(p.Compose) == "" || len(p.Analyze) > 32768 || len(p.Compose) > 32768) {
			return domain.Fail("INVALID_BUSINESS_PROMPT", 400)
		}
	}
	return nil
}

// Frozen retains execution models, endpoints, budgets and prompts without credentials.
type Frozen struct {
	Followup config.Release         `json:"followup"`
	Report   config.Release         `json:"report"`
	Options  config.Queue           `json:"options"`
	Policy   *domain.FollowupPolicy `json:"policy,omitempty"`
	Hash     string                 `json:"hash"`
}

// Resolve applies global defaults, then the package overrides, to the configured pipeline.
func Resolve(c config.Config, global, pack Settings, original *domain.FollowupPolicy) Frozen {
	f := Frozen{Followup: c.Release("followup"), Report: c.Release("report"), Options: c.Queue, Policy: original}
	if pack.Policy != nil {
		f.Policy = pack.Policy
	}
	if f.Policy != nil {
		policy := *f.Policy
		if policy.MaxFollowups != nil {
			limit := *policy.MaxFollowups
			policy.MaxFollowups = &limit
		}
		f.Policy = &policy
	}
	for _, item := range []struct {
		r    *config.Release
		g, p *Prompts
	}{{&f.Followup, global.Followup, pack.Followup}, {&f.Report, global.Report, pack.Report}} {
		if item.r.Pipeline.Model.Temperature != nil {
			temperature := *item.r.Pipeline.Model.Temperature
			item.r.Pipeline.Model.Temperature = &temperature
		}
		p := item.g
		if item.p != nil {
			p = item.p
		}
		if p != nil {
			item.r.Pipeline.Analyze, item.r.Pipeline.Compose = p.Analyze, p.Compose
			item.r.Hash = ""
			item.r.Pipeline.Version = "admin-" + config.Hash(*item.r)[:24]
			item.r.Hash = config.Hash(*item.r)
		}
	}
	f.Hash = config.Hash(f)
	return f
}

func (f Frozen) Valid() bool {
	hash := f.Hash
	f.Hash = ""
	return hash == config.Hash(f) && f.Followup.Kind == "followup" && f.Report.Kind == "report" && f.Followup.ValidHash() && f.Report.ValidHash()
}
