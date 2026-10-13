package published

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const fixture = `{"fieldnoteId":"FN-中文","profile":{"name":"专家","industry":"工程","role":"审查","years":"10","stage":"成熟","experience":"经验","materials":[]},"questions":[{"id":"Q01","title":"任务","type":"开放题","question":"说明实际任务","followUp":"可选提示","sourceRefs":[{"sourceType":"model_inference","title":"设计来源"}]}],"questionPackMeta":{"packId":"pack-1","version":1,"checksum":"old-checksum","sourceSessionId":"session-1"},"invitation":{"code":"123456","createdAt":"2026-10-13","status":"active"},"publishedAt":"2026-10-13"}`

func TestDSHPublicationPreservesDataWithoutRequiredSlots(t *testing.T) {
	p, hash, err := Parse([]byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	if p.Questions[0].FollowUp != "可选提示" || len(p.Questions[0].SourceRefs) != 1 || p.Profile.Years != "10" || len(hash) != 64 {
		t.Fatal("publication fields lost")
	}
	view, _ := json.Marshal(p.ParticipantView())
	if strings.Contains(string(view), "123456") || strings.Contains(string(view), "invitation") || strings.Contains(string(view), "materials") {
		t.Fatal("private fields exposed")
	}
	formatted := " \n" + fixture + "\n"
	_, other, err := Parse([]byte(formatted))
	if err != nil || other != hash {
		t.Fatal("formatting changed identity")
	}
	changed := strings.Replace(fixture, "经验", "changed background", 1)
	_, other, err = Parse([]byte(changed))
	if err != nil || other == hash {
		t.Fatal("background not bound to hash")
	}
}

func TestConcurrentDifferentUploadsCannotReplaceEachOther(t *testing.T) {
	d, err := OpenDirectory(t.TempDir(), 10000)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, raw := range []string{fixture, strings.Replace(fixture, "经验", "different", 1)} {
		wg.Add(1)
		go func(raw string) {
			defer wg.Done()
			<-start
			_, err := d.Publish("same-key", []byte(raw))
			results <- err
		}(raw)
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatal("concurrent conflicting uploads were not exclusive")
	}
	if _, err := d.Read("same-key"); err != nil {
		t.Fatal("published winner is incomplete")
	}
}
func TestMalformedPublicationsAreRejected(t *testing.T) {
	for _, raw := range []string{fixture + "{}", strings.Replace(fixture, `"version":1`, `"version":0`, 1), strings.Replace(fixture, `"id":"Q01"`, `"id":"../Q01"`, 1), strings.Replace(fixture, `"publishedAt":"2026-10-13"`, `"publishedAtt":"typo"`, 1)} {
		if _, _, err := Parse([]byte(raw)); err == nil {
			t.Fatal("invalid publication accepted")
		}
	}
}
func TestDirectoryAtomicPublicationAndIsolation(t *testing.T) {
	root := t.TempDir()
	d, err := OpenDirectory(root, 10000)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	first, err := d.Publish("FN-safe-v1", []byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Publish("FN-safe-v1", []byte(strings.Replace(fixture, "经验", "different", 1))); err == nil {
		t.Fatal("immutable package replaced")
	}
	if same, err := d.Publish("FN-safe-v1", []byte(fixture)); err != nil || same.Hash != first.Hash {
		t.Fatal("retry not idempotent")
	}
	for _, key := range []string{"../outside", "%2e%2e", "a/b", `a\b`, ""} {
		if _, err := d.Read(key); err == nil {
			t.Fatal("path-shaped key accepted")
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Read("escape"); err == nil {
		t.Fatal("escaping symlink read")
	}
	if err := os.WriteFile(filepath.Join(root, "unfinished.tmp"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "broken.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	entries, issues, err := d.Scan()
	if err != nil || len(entries) != 1 || len(issues) != 2 {
		t.Fatalf("scan: entries=%d issues=%d err=%v", len(entries), len(issues), err)
	}
}
func TestPublicationSizeLimit(t *testing.T) {
	d, err := OpenDirectory(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Publish("pack", []byte(fixture)); err == nil {
		t.Fatal("oversized publication accepted")
	}
}

func TestBrowserBindingDigestExcludesInvitationCode(t *testing.T) {
	raw := strings.Replace(fixture, `"publishedAt":"2026-10-13"`, `"publishedAt":"2026-10-13","interviewPolicy":{"scope":"per_question","maxFollowups":1}`, 1)
	p, hash, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	p.Goal = "interview goal"
	first, err := (Entry{Key: "test", Pack: p, Hash: hash}).Snapshot("test-session")
	if err != nil {
		t.Fatal(err)
	}
	p.Invitation.Code = "654321"
	second, err := (Entry{Key: "test", Pack: p, Hash: "private-digest"}).Snapshot("test-session")
	if err != nil {
		t.Fatal(err)
	}
	if first.Pack.Hash != second.Pack.Hash {
		t.Fatal("browser digest exposes invitation-dependent input")
	}
	p.Goal = "different interview goal"
	third, err := (Entry{Key: "test", Pack: p}).Snapshot("test-session")
	if err != nil || third.Pack.Hash == first.Pack.Hash {
		t.Fatal("goal is not bound")
	}
}
