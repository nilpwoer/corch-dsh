package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

// legacySourceRefJSON reproduces pre-normalization digests without Question.MarshalJSON.
func legacySourceRefJSON(s domain.Snapshot) []byte {
	type legacyQuestion domain.Question
	questions := []legacyQuestion{}
	for _, q := range s.Questions {
		questions = append(questions, legacyQuestion(q))
	}
	questions[0].SourceRefs = json.RawMessage(`[{"sourceType":"note","title":"Synthetic reference","locator":"local:fixture","excerpt":"Synthetic excerpt","requiresConfirmation":true}]`)
	v := struct {
		InterviewID         string              `json:"interview_id"`
		InputVersion        int64               `json:"input_version"`
		QuestionPackVersion int64               `json:"question_pack_version"`
		Profile             domain.Profile      `json:"profile"`
		Questions           []legacyQuestion    `json:"questions"`
		Answers             []domain.Answer     `json:"answers"`
		Pack                *domain.PackContext `json:"pack,omitempty"`
	}{s.InterviewID, s.InputVersion, s.QuestionPackVersion, s.Profile, questions, s.Answers, s.Pack}
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

func verifySourceRefCompatibility(t *testing.T, db *sql.DB, req func(*http.Client, string, string, string, any) (int, []byte), expert *http.Client, interviewID string, original domain.Submit, originalTask store.Task) {
	t.Helper()
	digest := func(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
	legacySnapshot := legacySourceRefJSON(original.Snapshot)
	legacySubmit, err := json.Marshal(struct {
		Kind     string          `json:"kind"`
		Snapshot json.RawMessage `json:"snapshot"`
	}{original.Kind, legacySnapshot})
	if err != nil {
		t.Fatal(err)
	}
	oldSnapshotHash, oldRequestHash := digest(legacySnapshot), digest(legacySubmit)
	if oldSnapshotHash == config.Hash(original.Snapshot) || oldRequestHash == config.Hash(original) {
		t.Fatal("legacy fixture must differ from normalized digest")
	}
	// Only this synthetic database is edited to reproduce retained pre-fix metadata.
	if _, err := db.Exec("UPDATE tw_interviews SET input_hash=? WHERE id=?", oldSnapshotHash, interviewID); err != nil {
		t.Fatal(err)
	}
	requestKey := "portal:" + interviewID + ":portal-report"
	if _, err := db.Exec("UPDATE tw_requests SET input_hash=? WHERE request_key=?", oldRequestHash, requestKey); err != nil {
		t.Fatal(err)
	}
	var snapshotBefore, inputBefore, outputBefore []byte
	if err := db.QueryRow("SELECT contents FROM tw_snapshots WHERE interview_id=? AND input_version=?", interviewID, original.Snapshot.InputVersion).Scan(&snapshotBefore); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT input,output FROM tw_tasks WHERE id=?", originalTask.ID).Scan(&inputBefore, &outputBefore); err != nil {
		t.Fatal(err)
	}
	status, body := req(expert, "GET", "/portal/api/session", "", nil)
	var restored struct {
		Snapshot domain.Snapshot `json:"snapshot"`
		Frozen   bool            `json:"frozen"`
	}
	if status != 200 || json.Unmarshal(body, &restored) != nil || !restored.Frozen {
		t.Fatal("frozen session restoration failed")
	}
	var mysqlSnapshot domain.Snapshot
	if err := json.Unmarshal(snapshotBefore, &mysqlSnapshot); err != nil {
		t.Fatal(err)
	}
	if config.Hash(mysqlSnapshot) != config.Hash(original.Snapshot) || config.Hash(restored.Snapshot) != config.Hash(original.Snapshot) {
		t.Fatal("MySQL JSON round trip changed snapshot identity")
	}
	replay := domain.Submit{Kind: "report", Snapshot: restored.Snapshot}
	status, body = req(expert, "POST", "/portal/api/tasks", "portal-report", replay)
	var duplicate store.Task
	if status != 202 || json.Unmarshal(body, &duplicate) != nil || duplicate.ID != originalTask.ID {
		t.Fatalf("historical idempotent retry: %d %s", status, body)
	}
	changed := replay
	changed.Snapshot.Answers = append([]domain.Answer(nil), replay.Snapshot.Answers...)
	changed.Snapshot.Answers[0].Text += " changed"
	for _, test := range []struct{ key, code string }{{"portal-report", "IDEMPOTENCY_CONFLICT"}, {"changed-answer-new-key", "INPUT_VERSION_CONFLICT"}} {
		status, body = req(expert, "POST", "/portal/api/tasks", test.key, changed)
		if status != 409 || !bytes.Contains(body, []byte(test.code)) {
			t.Fatalf("changed answer accepted: %d %s", status, body)
		}
	}
	changed = replay
	changed.Snapshot.Questions = append([]domain.Question(nil), replay.Snapshot.Questions...)
	changed.Snapshot.Questions[0].SourceRefs = json.RawMessage(`[{"sourceType":"note","title":"Tampered reference"}]`)
	status, body = req(expert, "POST", "/portal/api/tasks", "changed-reference", changed)
	if status != 409 || !bytes.Contains(body, []byte("QUESTION_PACK_MISMATCH")) {
		t.Fatal("changed reference accepted")
	}
	status, body = req(expert, "POST", "/portal/api/tasks", "regenerate-after-reload", replay)
	var regenerated store.Task
	if status != 202 || json.Unmarshal(body, &regenerated) != nil || regenerated.ID == originalTask.ID || regenerated.ReportVersion != originalTask.ReportVersion+1 {
		t.Fatalf("page regeneration after reload: %d %s", status, body)
	}
	status, body = req(expert, "POST", "/portal/api/tasks", "regenerate-after-reload", replay)
	var repeated store.Task
	if status != 202 || json.Unmarshal(body, &repeated) != nil || repeated.ID != regenerated.ID {
		t.Fatal("normalized idempotent retry created a duplicate")
	}
	wait(t, func() bool {
		_, body = req(expert, "GET", "/portal/api/tasks/"+regenerated.ID, "", nil)
		_ = json.Unmarshal(body, &regenerated)
		return regenerated.Status == "succeeded" || regenerated.Status == "failed"
	})
	if regenerated.Status != "succeeded" {
		t.Fatal("regenerated synthetic report failed")
	}
	var snapshotAfter, inputAfter, outputAfter []byte
	var retainedSnapshotHash, retainedRequestHash string
	if err := db.QueryRow("SELECT contents FROM tw_snapshots WHERE interview_id=? AND input_version=?", interviewID, original.Snapshot.InputVersion).Scan(&snapshotAfter); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT input,output FROM tw_tasks WHERE id=?", originalTask.ID).Scan(&inputAfter, &outputAfter); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT input_hash FROM tw_interviews WHERE id=?", interviewID).Scan(&retainedSnapshotHash); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT input_hash FROM tw_requests WHERE request_key=?", requestKey).Scan(&retainedRequestHash); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(snapshotBefore, snapshotAfter) || !bytes.Equal(inputBefore, inputAfter) || !bytes.Equal(outputBefore, outputAfter) || retainedSnapshotHash != oldSnapshotHash || retainedRequestHash != oldRequestHash {
		t.Fatal("legacy snapshot, report or digests rewritten")
	}
}
