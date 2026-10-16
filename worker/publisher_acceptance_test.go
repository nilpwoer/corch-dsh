package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/fanzy531/corch-dsh/worker/internal/publisherauth"
	"github.com/fanzy531/corch-dsh/worker/internal/service"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

var publisherOldBinary = flag.String("publisher-old-binary", "", "Schema4 release for isolated publisher migration acceptance")

// TestPublisherAcceptance uses only a new randomly named database and synthetic publications.
func TestPublisherAcceptance(t *testing.T) {
	if *mysqlConfigPath == "" {
		t.Skip("requires explicit isolated MySQL input")
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal("Isolated publisher acceptance failed; private details suppressed")
		}
	}
	raw, err := os.ReadFile(*mysqlConfigPath)
	must(err)
	var source struct {
		Database struct {
			DSN string `yaml:"dsn"`
		} `yaml:"database"`
	}
	must(yaml.Unmarshal(raw, &source))
	d, err := driver.ParseDSN(source.Database.DSN)
	must(err)
	d.DBName = ""
	d.ParseTime = true
	d.Loc = time.UTC
	admin, err := sql.Open("mysql", d.FormatDSN())
	must(err)
	defer admin.Close()
	name := "tw_access_accept_pub_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if !strings.HasPrefix(name, "tw_access_accept_pub_") || len(name) != 53 {
		t.Fatal("isolated database guard")
	}
	_, err = admin.Exec("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	must(err)
	defer func() { _, err := admin.Exec("DROP DATABASE `" + name + "`"); must(err) }()
	d.DBName = name
	c, err := config.Load("config.example.yaml")
	must(err)
	c.Database.DSN = d.FormatDSN()
	c.Database.AutoMigrate = true
	c.Mode = "api"
	c.Auth.Token = "synthetic-publisher-backend-only-123456"
	for k, p := range c.Providers {
		p.APIKey = ""
		c.Providers[k] = p
	}
	root := t.TempDir()
	packs := filepath.Join(root, "packs")
	assets := filepath.Join(root, "assets")
	must(os.Mkdir(packs, 0700))
	must(os.Mkdir(assets, 0700))
	for _, n := range []string{"practice-expert-interview-spa.html", "practice-expert-worker.js"} {
		must(os.WriteFile(filepath.Join(assets, n), []byte("synthetic publisher fixture"), 0600))
	}
	server := httptest.NewUnstartedServer(http.NewServeMux())
	defer server.Close()
	hash, err := accounts.Hash("synthetic-publisher-test-only")
	must(err)
	c.Portal = config.Portal{Enabled: true, Origin: "http://" + server.Listener.Addr().String(), PacksDir: packs, AssetsDir: assets, SessionTTL: time.Hour, MaxPackBytes: c.Server.MaxBodyBytes, ModelLabel: "synthetic isolated model", ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", PollInterval: time.Second, LoginLimit: 100, LoginWindow: time.Minute, AdminPasswordHash: hash}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	c.Server.Listen = listener.Addr().String()
	must(listener.Close())
	private := filepath.Join(root, "config.yaml")
	encoded, err := yaml.Marshal(c)
	must(err)
	must(os.WriteFile(private, encoded, 0600))
	_, err = config.Load(private)
	must(err)
	ctx := context.Background()
	s, err := store.Open(ctx, c)
	must(err)
	db, err := s.DB.DB()
	must(err)
	// Construct the exact schema4 starting point with retained legacy publication and database-owned access.
	legacy := []byte(`{"fieldnoteId":"FN-retained","questionPackMeta":{"version":1},"goal":"synthetic","profile":{"name":"synthetic","role":"synthetic"},"questions":[{"id":"Q01","question":"synthetic question"}],"interviewPolicy":{"scope":"per_question","maxFollowups":0},"invitation":{"code":"000000","status":"active","createdAt":"synthetic"}}`)
	dir, err := published.OpenDirectory(packs, c.Portal.MaxPackBytes)
	must(err)
	entry, err := dir.Publish("FN-retained-v1", legacy)
	must(err)
	must(dir.Close())
	_, err = db.Exec("INSERT INTO tw_runtime_settings(scope_key,revision,publication_hash,contents) VALUES ('global',1,'','{}')")
	must(err)
	_, err = db.Exec("INSERT INTO tw_pack_access(pack_key,publication_hash,revision,code,status,source) VALUES (?,?,1,'retained-managed-code','active','worker')", entry.Key, entry.Hash)
	must(err)
	_, err = db.Exec("DROP TABLE tw_publisher_keys")
	must(err)
	_, err = db.Exec("UPDATE tw_schema SET version=4")
	must(err)
	must(s.Close())
	backup := filepath.Join(root, "schema4-backup")
	maint := func(operation string, success bool) {
		t.Helper()
		if *accessMaintBinary == "" {
			return
		}
		out, err := exec.Command(*accessMaintBinary, operation, "-config", private, "-backup", backup, "-isolated").CombinedOutput()
		if success && err != nil {
			t.Fatal("isolated publisher maintenance failed")
		}
		if !success && (err == nil || !bytes.Contains(out, []byte("STALE_BACKUP_REFUSED"))) {
			t.Fatal("stale publisher backup accepted")
		}
	}
	maint("backup", true)
	s, err = store.Open(ctx, c)
	must(err)
	db, err = s.DB.DB()
	must(err)
	var version, count int
	must(db.QueryRow("SELECT version FROM tw_schema").Scan(&version))
	must(db.QueryRow("SELECT COUNT(*) FROM tw_publisher_keys").Scan(&count))
	if version != 5 || count != 0 {
		t.Fatal("schema4→5 must create no credentials")
	}
	v, err := s.ReadPackAccess(ctx, entry)
	must(err)
	if v.Code != "retained-managed-code" || v.Revision != 1 {
		t.Fatal("managed invitation changed")
	}
	maint("guard", true)
	if *accessMaintBinary != "" {
		must(s.Close())
		maint("restore", true)
		if *publisherOldBinary != "" {
			func() {
				run, cancel := context.WithCancel(ctx)
				cmd := exec.CommandContext(run, *publisherOldBinary, "serve", "-c", private)
				must(cmd.Start())
				done := make(chan error, 1)
				go func() { done <- cmd.Wait() }()
				defer func() {
					cancel()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("owned schema4 process did not exit")
					}
				}()
				ready := false
				for n := 0; n < 50; n++ {
					res, err := http.Get("http://" + c.Server.Listen + "/health")
					if err == nil {
						res.Body.Close()
						if res.StatusCode == 200 {
							ready = true
							break
						}
					}
					time.Sleep(100 * time.Millisecond)
				}
				if !ready {
					t.Fatal("schema4 binary not healthy after guarded full restore")
				}
			}()
		}
		s, err = store.Open(ctx, c)
		must(err)
		db, err = s.DB.DB()
		must(err)
	}
	defer s.Close()
	key, token, err := s.CreatePublisherKey(ctx, "synthetic desktop", nil)
	must(err)
	var savedHash string
	must(db.QueryRow("SELECT token_hash FROM tw_publisher_keys WHERE id=?", key.ID).Scan(&savedHash))
	want, _ := publisherauth.Hash(token)
	if savedHash != want || strings.Contains(savedHash, token) {
		t.Fatal("credential storage is not hash-only")
	}
	keys, err := s.ListPublisherKeys(ctx)
	must(err)
	listed, _ := json.Marshal(keys)
	if bytes.Contains(listed, []byte(token)) || bytes.Contains(listed, []byte(savedHash)) {
		t.Fatal("credential reread leaked secret")
	}
	handler, err := service.Handler(s)
	must(err)
	server.Config.Handler = handler
	server.Start()
	request := func(method, path, body, credential string, want int) []byte {
		t.Helper()
		req, err := http.NewRequest(method, c.Portal.Origin+path, strings.NewReader(body))
		must(err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", c.Portal.Origin)
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		res, err := http.DefaultClient.Do(req)
		must(err)
		defer res.Body.Close()
		out, err := io.ReadAll(res.Body)
		must(err)
		if res.StatusCode != want {
			t.Fatalf("publisher HTTP %s %s: %d want%d", method, path, res.StatusCode, want)
		}
		if bytes.Contains(out, []byte(token)) {
			t.Fatal("publisher token appeared in response")
		}
		return out
	}
	payload := strings.Replace(string(legacy), "FN-retained", "FN-published", 1)
	request("POST", "/publish/api/packs/FN-published-v1", payload, "", 401)
	a := request("POST", "/publish/api/packs/FN-published-v1", payload, token, 201)
	b := request("POST", "/publish/api/packs/FN-published-v1", payload, token, 201)
	if !bytes.Equal(a, b) {
		t.Fatal("idempotent receipt changed")
	}
	for _, path := range []string{"/admin/api/reports", "/admin/api/reports/unrelated/view", "/admin/api/packs", "/admin/api/settings", "/admin/api/publisher-keys"} {
		request("GET", path, "", token, 401)
	}
	request("POST", "/admin/api/publisher-keys", `{"name":"escalation"}`, token, 401)
	request("POST", "/v1/tasks", "{}", token, 401)
	keys, err = s.ListPublisherKeys(ctx)
	must(err)
	if keys[0].LastUsedAt == nil {
		t.Fatal("successful use not recorded")
	}
	must(s.RevokePublisherKey(ctx, key.ID))
	request("POST", "/publish/api/packs/FN-published-v1", payload, token, 401)
	expires := time.Now().Add(time.Hour)
	exp, expiredToken, err := s.CreatePublisherKey(ctx, "expires", &expires)
	must(err)
	_, err = db.Exec("UPDATE tw_publisher_keys SET expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?", exp.ID)
	must(err)
	request("POST", "/publish/api/packs/FN-published-v1", payload, expiredToken, 401)
	maint("guard", false)
	maint("restore", false)
	must(db.QueryRow("SELECT version FROM tw_schema").Scan(&version))
	if version != 5 {
		t.Fatal("stale restore damaged schema")
	}
	var calls int
	must(db.QueryRow("SELECT COUNT(*) FROM tw_calls").Scan(&calls))
	if calls != 0 {
		t.Fatal("unexpected model call")
	}
	retained, err := os.ReadFile(filepath.Join(packs, "FN-retained-v1.json"))
	must(err)
	if !bytes.Equal(retained, legacy) {
		t.Fatal("legacy publication bytes changed")
	}
	if *publisherOldBinary != "" {
		run, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(run, *publisherOldBinary, "serve", "-c", private).CombinedOutput()
		if err == nil || run.Err() != nil || !bytes.Contains(out, []byte("结构版本")) {
			t.Fatal("schema4 binary did not promptly reject5")
		}
	}
	t.Log("schema4→5; full guarded4 restore and old binary healthy before writes; old invitations/settings/files retained; no bootstrap Keys; hash-only credentials; no-cookie publishing/retry; expired/revoked rejected; no admin/report/model authority; stale restore refused; model calls0; random database deferred drop")
}
