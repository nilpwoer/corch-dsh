package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type runtimeSetting struct {
	ScopeKey        string `gorm:"primaryKey"`
	Revision        int64
	PublicationHash string
	Contents        json.RawMessage
}

func (runtimeSetting) TableName() string { return "tw_runtime_settings" }

type interviewRuntime struct {
	InterviewID string `gorm:"primaryKey"`
	Contents    json.RawMessage
}

func (interviewRuntime) TableName() string { return "tw_interview_runtime" }

// SettingsView contains editable text and policy only; it never exposes execution credentials.
type SettingsView struct {
	Revision        int64                         `json:"revision"`
	PublicationHash string                        `json:"publication_hash,omitempty"`
	Settings        runtimecfg.Settings           `json:"settings"`
	Effective       map[string]runtimecfg.Prompts `json:"effective"`
	Policy          *domain.FollowupPolicy        `json:"policy,omitempty"`
	PolicySource    string                        `json:"policy_source,omitempty"`
}

func readRuntimeSetting(tx *gorm.DB, key string, entry *published.Entry) (runtimeSetting, runtimecfg.Settings, error) {
	var row runtimeSetting
	err := tx.Where("scope_key=?", key).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return row, runtimecfg.Settings{}, nil
	}
	if err != nil {
		return row, runtimecfg.Settings{}, err
	}
	if entry != nil && row.PublicationHash != entry.Hash {
		return row, runtimecfg.Settings{}, domain.Fail("SETTINGS_PUBLICATION_CHANGED", 409)
	}
	var value runtimecfg.Settings
	if json.Unmarshal(row.Contents, &value) != nil || value.Validate(entry == nil) != nil {
		return row, value, domain.Fail("INVALID_SAVED_SETTINGS", 500)
	}
	return row, value, nil
}

func (s *Store) readResolvedRuntime(tx *gorm.DB, entry *published.Entry) (runtimecfg.Frozen, runtimeSetting, runtimecfg.Settings, error) {
	globalRow, global, err := readRuntimeSetting(tx, "global", nil)
	if err != nil {
		return runtimecfg.Frozen{}, globalRow, global, err
	}
	row, pack := globalRow, runtimecfg.Settings{}
	var policy *domain.FollowupPolicy
	if entry != nil {
		row, pack, err = readRuntimeSetting(tx, "pack:"+entry.Key, entry)
		policy = entry.Pack.Policy
		if policy == nil {
			policy = domain.NewInterviewPolicy(nil)
		}
	}
	settings := global
	if entry != nil {
		settings = pack
	}
	return runtimecfg.Resolve(s.Config, global, pack, policy), row, settings, err
}

func (s *Store) ReadRuntimeSettings(ctx context.Context, entry *published.Entry) (SettingsView, error) {
	f, row, settings, err := s.readResolvedRuntime(s.DB.WithContext(ctx), entry)
	if err != nil {
		return SettingsView{}, err
	}
	view := SettingsView{Revision: row.Revision, Settings: settings, Effective: map[string]runtimecfg.Prompts{"followup": {Analyze: f.Followup.Pipeline.Analyze, Compose: f.Followup.Pipeline.Compose}, "report": {Analyze: f.Report.Pipeline.Analyze, Compose: f.Report.Pipeline.Compose}}, Policy: f.Policy}
	if entry != nil {
		view.PublicationHash = entry.Hash
		view.PolicySource = "package"
		if entry.Pack.Policy == nil {
			view.PolicySource = "built_in"
		}
		if settings.Policy != nil {
			view.PolicySource = "override"
		}
	}
	return view, nil
}

// SaveRuntimeSettings uses a revision comparison; uploads never overwrite this separate record.
func (s *Store) SaveRuntimeSettings(ctx context.Context, entry *published.Entry, revision int64, value runtimecfg.Settings) (SettingsView, error) {
	if err := value.Validate(entry == nil); err != nil {
		return SettingsView{}, err
	}
	if value.Policy != nil && *value.Policy.MaxFollowups > domain.MaxQuestionFollowups {
		return SettingsView{}, domain.Fail("INVALID_FOLLOWUP_POLICY", 400)
	}
	key, hash := "global", ""
	if entry != nil {
		key, hash = "pack:"+entry.Key, entry.Hash
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("INSERT INTO tw_runtime_settings(scope_key,revision,publication_hash,contents) VALUES (?,0,?,?) ON DUPLICATE KEY UPDATE scope_key=scope_key", key, hash, encode(runtimecfg.Settings{})).Error; err != nil {
			return err
		}
		var row runtimeSetting
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("scope_key=?", key).Take(&row).Error; err != nil {
			return err
		}
		if row.Revision != revision {
			return domain.Fail("SETTINGS_REVISION_CONFLICT", 409)
		}
		return tx.Model(&runtimeSetting{}).Where("scope_key=?", key).Updates(map[string]any{"revision": revision + 1, "publication_hash": hash, "contents": encode(value)}).Error
	})
	if err != nil {
		return SettingsView{}, err
	}
	return s.ReadRuntimeSettings(ctx, entry)
}

func frozenRuntime(tx *gorm.DB, id string) (*runtimecfg.Frozen, error) {
	var row interviewRuntime
	err := tx.Where("interview_id=?", id).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var frozen runtimecfg.Frozen
	if json.Unmarshal(row.Contents, &frozen) != nil || !frozen.Valid() {
		return nil, domain.Fail("INVALID_FROZEN_RUNTIME", 500)
	}
	return &frozen, nil
}
