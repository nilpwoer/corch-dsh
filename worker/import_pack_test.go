package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const importFixture = `{"schemaVersion":1,"fieldnoteId":"synthetic-test","goal":"Synthetic test goal","profile":{"name":"Synthetic"},"questions":[{"id":"Q01","question":"Synthetic fixture, never a real generation"}],"questionPackMeta":{"version":1},"interviewPolicy":{"scope":"per_question","maxFollowups":1},"invitation":{"code":"TEST-ONLY-SECRET","status":"active"}}`

func TestImportPackDryRunIdempotenceConflictAndNoCredentials(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "packs")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "input.json")
	if err := os.WriteFile(file, []byte(importFixture), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(extra ...string) (string, error) {
		c := newCommand()
		var out bytes.Buffer
		c.SetOut(&out)
		c.SetArgs(append([]string{"import-pack", "--file", file, "--packs-dir", directory, "--key", "test-v1", "--max-bytes", "10000", "--require-invitation"}, extra...))
		err := c.Execute()
		return out.String(), err
	}
	if _, err := run("--dry-run"); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(directory)
	if len(files) != 0 {
		t.Fatal("dry-run wrote files")
	}
	if out, err := run(); err != nil || strings.Contains(out, "TEST-ONLY-SECRET") || strings.Contains(out, `"hash"`) {
		t.Fatalf("import failed or leaked invitation: %v", err)
	}
	if out, err := run(); err != nil || !strings.Contains(out, `"already_present":true`) {
		t.Fatal("retry was not idempotent")
	}
	before, _ := os.ReadFile(filepath.Join(directory, "test-v1.json"))
	if err := os.WriteFile(file, []byte(strings.Replace(importFixture, "Synthetic test goal", "Different", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{nil, {"--dry-run"}} {
		if _, err := run(args...); err == nil {
			t.Fatal("conflict accepted")
		}
	}
	after, _ := os.ReadFile(filepath.Join(directory, "test-v1.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("conflict replaced publication")
	}
}

func TestImportPackRejectsUnrunnableAndUnsafeInputs(t *testing.T) {
	for _, raw := range []string{`{`, strings.Replace(importFixture, `"goal":"Synthetic test goal"`, `"goal":""`, 1), strings.Replace(importFixture, `"scope":"per_question"`, `"scope":"wrong"`, 1), strings.Replace(importFixture, `"version":1`, `"version":0`, 1), strings.Replace(importFixture, `"status":"active"`, `"status":"revoked"`, 1)} {
		root := t.TempDir()
		file := filepath.Join(root, "input.json")
		_ = os.WriteFile(file, []byte(raw), 0600)
		c := newCommand()
		c.SetArgs([]string{"import-pack", "--file", file, "--packs-dir", root, "--key", "test", "--max-bytes", "10000", "--require-invitation", "--dry-run"})
		if c.Execute() == nil {
			t.Fatal("invalid publication accepted")
		}
	}
}
