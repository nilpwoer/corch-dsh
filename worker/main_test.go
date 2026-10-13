package main

import (
	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServeRequiresConfig(t *testing.T) {
	c := newCommand()
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	c.SetArgs([]string{"serve"})
	err := c.Execute()
	if err == nil || !strings.Contains(err.Error(), "config") {
		t.Fatalf("expected required config, got %v", err)
	}
}
func TestServeRejectsPositionals(t *testing.T) {
	c := newCommand()
	c.SetArgs([]string{"serve", "unexpected", "-c", "missing.yaml"})
	if c.Execute() == nil {
		t.Fatal("unexpected argument accepted")
	}
}

func TestPasswordHashCommandDoesNotPrintOrOverwriteCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "password-hash")
	c := newCommand()
	c.SetIn(strings.NewReader("synthetic-test-input\n"))
	var output strings.Builder
	c.SetOut(&output)
	c.SetArgs([]string{"hash-password", "--output", path})
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !accounts.Verify(strings.TrimSpace(string(raw)), "synthetic-test-input") || strings.Contains(output.String(), "synthetic-test-input") || strings.Contains(output.String(), "pbkdf2-") {
		t.Fatal("unsafe password hash command")
	}
	c = newCommand()
	c.SetIn(strings.NewReader("different-test-input"))
	c.SetArgs([]string{"hash-password", "--output", path})
	if c.Execute() == nil {
		t.Fatal("existing hash overwritten")
	}
}
