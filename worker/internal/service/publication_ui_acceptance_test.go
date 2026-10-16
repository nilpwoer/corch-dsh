package service

import (
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

var publisherUIHandoff = flag.String("publisher-ui-handoff", "", "Synthetic native API Key regression handoff")

func TestPublisherUIFixture(t *testing.T) {
	if *publisherUIHandoff == "" {
		t.Skip("requires explicit publisher handoff")
	}
	*publicationUIHandoff = *publisherUIHandoff
	TestPublicationUIFixture(t)
}

var publicationUIHandoff = flag.String("publication-ui-handoff", "", "Synthetic local desktop acceptance handoff; no SQL or model provider")

type publicationUIBackend struct {
	fakeManagement
	mu                sync.Mutex
	config            config.Config
	settings          map[string]store.SettingsView
	participant       *store.ParticipantSession
	modelRequests     int
	publisherRequests int
	publisherMode string
}

func (b *publicationUIBackend) Get(ctx context.Context, id string) (store.Task, error) {
	if id != "report-test" {
		return b.fakeManagement.Get(ctx, id)
	}
	snapshot := domain.Snapshot{InterviewID: "synthetic-ui-interview", InputVersion: 1, Questions: []domain.Question{{ID: "Q01", Text: "请描述合成核对过程"}}, Answers: []domain.Answer{{QuestionID: "Q01", Text: "我会核对原始作品和采用记录。", Confirmed: true}}}
	input, _ := json.Marshal(store.Input{Submit: domain.Submit{Snapshot: snapshot}})
	output, _ := json.Marshal(domain.ReportResult{ReportVersion: 1, InputVersion: 1, Report: domain.Report{Title: "合成访谈报告", Sections: []domain.Section{{Title: "专家确认摘要", Statements: []domain.Statement{{Kind: "fact", Text: "我会核对原始作品和采用记录。", EvidenceIDs: []string{"E1"}}}}}, TaskCards: []domain.TaskCard{}, NeedsVerification: []string{}}, Evidence: []domain.Evidence{{ID: "E1", QuestionID: "Q01", Quote: "我会核对原始作品和采用记录。"}}})
	release, _ := json.Marshal(b.config.Release("report"))
	return store.Task{ID: id, InterviewID: snapshot.InterviewID, Kind: "report", Status: "succeeded", ReportVersion: 1, Input: input, Output: output, ReleaseData: release}, nil
}

func (b *publicationUIBackend) view(entry *published.Entry) store.SettingsView {
	key := ""
	var original *domain.FollowupPolicy
	if entry != nil {
		key = entry.Key
		original = entry.Pack.Policy
	}
	v := b.settings[key]
	f := runtimecfg.Resolve(b.config, b.settings[""].Settings, v.Settings, original)
	v.Policy = f.Policy
	v.Effective = map[string]runtimecfg.Prompts{"followup": {Analyze: f.Followup.Pipeline.Analyze, Compose: f.Followup.Pipeline.Compose}, "report": {Analyze: f.Report.Pipeline.Analyze, Compose: f.Report.Pipeline.Compose}}
	if entry != nil {
		v.PublicationHash = entry.Hash
	}
	return v
}
func (b *publicationUIBackend) ReadRuntimeSettings(_ context.Context, entry *published.Entry) (store.SettingsView, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.view(entry), nil
}
func (b *publicationUIBackend) SaveRuntimeSettings(_ context.Context, entry *published.Entry, revision int64, settings runtimecfg.Settings) (store.SettingsView, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := settings.Validate(entry == nil); err != nil {
		return store.SettingsView{}, err
	}
	key := ""
	if entry != nil {
		key = entry.Key
	}
	v := b.settings[key]
	if v.Revision != revision {
		return v, domain.Fail("SETTINGS_REVISION_CONFLICT", 409)
	}
	v.Revision++
	v.Settings = settings
	b.settings[key] = v
	return b.view(entry), nil
}
func (b *publicationUIBackend) NewParticipantSession(_ context.Context, entry published.Entry) (string, store.ParticipantSession, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	v := b.view(&entry)
	if v.Policy == nil {
		return "", store.ParticipantSession{}, domain.Fail("FOLLOWUP_POLICY_REQUIRED", 409)
	}
	raw, _ := json.Marshal(entry.Pack)
	row := store.ParticipantSession{InterviewID: "synthetic-ui-interview", PackKey: entry.Key, PackHash: entry.Hash, PackData: raw, RuntimePolicy: v.Policy}
	b.participant = &row
	return strings.Repeat("b", 64), row, nil
}
func (b *publicationUIBackend) ParticipantIdentity(_ context.Context, token string) (store.ParticipantSession, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.participant == nil || token != strings.Repeat("b", 64) {
		return store.ParticipantSession{}, domain.Fail("INTERVIEW_SESSION_REQUIRED", 401)
	}
	return *b.participant, nil
}
func (b *publicationUIBackend) LogoutParticipant(context.Context, string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.participant = nil
	return nil
}
func (b *publicationUIBackend) List(context.Context, string) ([]store.Task, error) {
	return []store.Task{}, nil
}
func (b *publicationUIBackend) Enqueue(context.Context, string, domain.Submit) (store.Task, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.modelRequests++
	return store.Task{}, domain.Fail("NO_MODEL_IN_UI_FIXTURE", 500)
}

// TestPublicationUIFixture mounts the real management/participant HTTP and assets.
// Only account/session storage is synthetic; uploads use real validation and immutable files.
func TestPublicationUIFixture(t *testing.T) {
	if *publicationUIHandoff == "" {
		t.Skip("requires explicit desktop handoff")
	}
	if _, err := os.Stat(*publicationUIHandoff); !os.IsNotExist(err) {
		t.Fatal("handoff must be new")
	}
	c, err := config.Load(filepath.Join("..", "..", "config.example.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	packs := t.TempDir()
	assets, err := filepath.Abs(filepath.Join("..", "..", "..", "apps", "web", "public"))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	server := httptest.NewUnstartedServer(mux)
	portal := config.Portal{Enabled: true, Origin: "http://" + server.Listener.Addr().String(), PacksDir: packs, AssetsDir: assets, SessionTTL: time.Hour, MaxPackBytes: 2097152, LoginLimit: 100, LoginWindow: time.Minute, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", PollInterval: time.Second}
	backend := &publicationUIBackend{config: c, settings: map[string]store.SettingsView{}}
	if err := mountManagement(mux, portal, backend); err != nil {
		t.Fatal(err)
	}
	if err := mountPortal(mux, portal, backend, 2097152, 32768); err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if *publisherUIHandoff!="" && r.URL.Path=="/__publisher_test_mode" && r.Method=="POST" { backend.mu.Lock();backend.publisherMode=r.Header.Get("X-Synthetic-Mode");backend.mu.Unlock();w.WriteHeader(204);return }
		if strings.HasPrefix(r.URL.Path, "/publish/api/") {
			backend.mu.Lock()
			backend.publisherRequests++
			mode:=backend.publisherMode
			backend.mu.Unlock()
			if mode=="network" { conn,_,err:=w.(http.Hijacker).Hijack();if err==nil{conn.Close()};return }
			if mode=="delay" {time.Sleep(300*time.Millisecond)}
		}
		mux.ServeHTTP(w, r)
	})
	server.Start()
	defer server.Close()
	raw, _ := json.Marshal(map[string]any{"origin": portal.Origin, "synthetic_password": "synthetic-test-only", "packs_directory": packs, "sql_backend": false, "real_worker_http": true})
	if err := os.WriteFile(*publicationUIHandoff, raw, 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(45 * time.Minute)
	for {
		raw, err = os.ReadFile(*publicationUIHandoff + ".done")
		if err == nil {
			break
		}
		if !os.IsNotExist(err) || time.Now().After(deadline) {
			t.Fatal("browser handoff timed out")
		}
		time.Sleep(100 * time.Millisecond)
	}
	var done struct {
		Passed bool `json:"passed"`
	}
	if json.Unmarshal(raw, &done) != nil || !done.Passed {
		t.Fatal("browser acceptance failed")
	}
	backend.mu.Lock()
	requests := backend.modelRequests
	backend.mu.Unlock()
	if requests != 0 {
		t.Fatal("unexpected model task")
	}
	if *publisherUIHandoff != "" {
		stats, _ := json.Marshal(map[string]any{"publisher_requests": backend.publisherRequests, "model_requests": requests, "actual_http_assets": true, "storage": "synthetic"})
		if err := os.WriteFile(*publisherUIHandoff+".stats", stats, 0600); err != nil {
			t.Fatal(err)
		}
		t.Log("Native publisher browser handoff passed; model requests=0; storage synthetic")
		return
	}
	for _, key := range []string{"FN-ui-v1", "FN-ui-v2", "FN-legacy-v1", "FN-legacy-v2"} {
		data, err := os.ReadFile(filepath.Join(packs, key+".json"))
		if err != nil {
			t.Fatal(err)
		}
		p, _, err := published.Parse(data)
		if err != nil {
			t.Fatal(err)
		}
		if key == "FN-legacy-v1" {
			if p.Policy == nil || p.Policy.Scope != "per_question" {
				t.Fatal("legacy policy changed")
			}
		} else if p.Policy != nil {
			t.Fatal("client imposed a new policy")
		}
		if err := os.WriteFile(filepath.Join(filepath.Dir(*publicationUIHandoff), key+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Log("Real HTTP/assets, package validation, immutable upload files and Worker policy editor passed; storage synthetic; model requests=0")
}
