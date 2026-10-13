package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../../config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "config.yaml")
	if err = os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
func TestConfig(t *testing.T) {
	t.Run("participant policies must be explicitly selected", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		c.Portal.Enabled = true
		c.Auth.Token = "synthetic-private-token-for-config-tests-only"
		c.Portal.PacksDir = t.TempDir()
		c.Portal.Origin = "http://127.0.0.1:3090"
		c.Portal.SessionTTL = c.Preview.SessionTTL
		c.Portal.MaxPackBytes = 1000
		c.Portal.LoginLimit = 10
		c.Portal.LoginWindow = c.Preview.PollInterval
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
		c.Portal.ParticipantsEnabled = true
		if c.Validate() == nil {
			t.Fatal("participant decisions inferred without explicit settings")
		}
		c.Portal.EntryMode = "link"
		c.Portal.InvitationMode = "none"
		c.Portal.ParticipantReports = "allow"
		c.Portal.AssetsDir = "assets"
		c.Portal.PollInterval = c.Preview.PollInterval
		c.Portal.ModelLabel = "fixture"
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
		c.Portal.Origin = "http://public.example"
		if c.Validate() == nil {
			t.Fatal("insecure public origin accepted")
		}
	})
	t.Run("captures inline prompt versions", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		r := c.Release("followup")
		if !r.ValidHash() || !strings.Contains(r.Pipeline.Analyze, "充分性") {
			t.Fatal("prompt not captured")
		}
		r.Pipeline.Compose += " changed"
		if r.ValidHash() {
			t.Fatal("changed prompt accepted")
		}
	})
	t.Run("release excludes credentials and permits key rotation", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		provider := c.Providers["deepseek"]
		provider.APIKey = "secret-that-must-not-be-persisted"
		c.Providers["deepseek"] = provider
		release := c.Release("followup")
		if release.Provider.APIKey != "" {
			t.Fatal("release contains credential")
		}
		provider.APIKey = "rotated-key"
		c.Providers["deepseek"] = provider
		if c.Release("followup").Hash != release.Hash {
			t.Fatal("key rotation changed prompt version")
		}
	})
	t.Run("rejects unknown keys", func(t *testing.T) {
		file := fixture(t)
		f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.WriteString("\nquue: {}\n")
		_ = f.Close()
		if _, err = Load(file); err == nil {
			t.Fatal("unknown field accepted")
		}
	})
	t.Run("rejects unsafe lease cadence", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		c.Queue.LeaseDuration = c.Queue.HeartbeatInterval
		if c.Validate() == nil {
			t.Fatal("invalid lease accepted")
		}
	})
	t.Run("rejects missing model controls", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		p := c.Prompts["report"]
		p.Model.Temperature = nil
		c.Prompts["report"] = p
		if c.Validate() == nil {
			t.Fatal("missing temperature accepted")
		}
	})
	t.Run("preview requires loopback and complete settings", func(t *testing.T) {
		c, err := Load(fixture(t))
		if err != nil {
			t.Fatal(err)
		}
		c.Preview.Enabled = true
		c.Server.Listen = "0.0.0.0:3090"
		if c.Validate() == nil {
			t.Fatal("public preview listener accepted")
		}
		c.Server.Listen = "127.0.0.1:3090"
		c.Preview.PackFile = ""
		if c.Validate() == nil {
			t.Fatal("missing preview pack accepted")
		}
	})
}
