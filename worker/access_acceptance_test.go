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
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/service"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

var accessOldBinary = flag.String("access-old-binary", "", "Schema3 binary used only against the disposable access acceptance database")
var accessMaintBinary = flag.String("access-maint-binary", "", "Guarded backup/restore helper used only against the disposable access database")
var accessFallbackBinary = flag.String("access-fallback-binary", "", "Schema4-compatible earlier UI build used only against disposable access data")
var accessDatabaseName = flag.String("access-database-name", "", "Predeclared disposable tw_access_accept_ database; never a production database")
var accessDropDatabase = flag.Bool("access-drop-database", false, "Explicit cleanup of the predeclared disposable database only")

var accessDatabasePattern = regexp.MustCompile(`^tw_access_accept_[0-9a-f]{32}$`)

func TestManagedAccessDatabaseNameGuard(t *testing.T) {
	for _, name := range []string{"production", "tw_access_accept_", "tw_access_accept_0000000000000000000000000000000g", "tw_access_accept_00000000000000000000000000000000;DROP DATABASE x"} {
		if accessDatabasePattern.MatchString(name) {
			t.Fatal("unsafe isolated database name accepted")
		}
	}
	if !accessDatabasePattern.MatchString("tw_access_accept_00000000000000000000000000000000") {
		t.Fatal("exact isolated database name rejected")
	}
}

func TestManagedAccessDatabaseAbsent(t *testing.T) {
	if *mysqlConfigPath == "" || *accessDatabaseName == "" {
		t.Skip("requires explicit connection and predeclared isolated database")
	}
	if !accessDatabasePattern.MatchString(*accessDatabaseName) {
		t.Fatal("isolated database name guard")
	}
	raw, err := os.ReadFile(*mysqlConfigPath)
	if err != nil {
		t.Fatal("isolated connection input unavailable")
	}
	var source struct {
		Database struct {
			DSN string `yaml:"dsn"`
		} `yaml:"database"`
	}
	if yaml.Unmarshal(raw, &source) != nil {
		t.Fatal("isolated connection input invalid")
	}
	d, err := driver.ParseDSN(source.Database.DSN)
	if err != nil || d.DBName == *accessDatabaseName {
		t.Fatal("isolated connection selection refused")
	}
	d.DBName = ""
	db, err := sql.Open("mysql", d.FormatDSN())
	if err != nil {
		t.Fatal("isolated database check unavailable")
	}
	defer db.Close()
	if *accessDropDatabase {
		if _, err := db.Exec("DROP DATABASE IF EXISTS `" + *accessDatabaseName + "`"); err != nil {
			t.Fatal("predeclared isolated database cleanup failed")
		}
	}
	var count int
	if db.QueryRow("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", *accessDatabaseName).Scan(&count) != nil || count != 0 {
		t.Fatal("predeclared test database is present or cannot be checked")
	}
	t.Log("isolated_database_absent=" + *accessDatabaseName)
}

func TestManagedAccessAcceptance(t *testing.T) {
	if *mysqlConfigPath == "" {
		t.Skip("requires explicit isolated MySQL acceptance input")
	}
	name := *accessDatabaseName
	if name == "" {
		name = "tw_access_accept_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	}
	if !accessDatabasePattern.MatchString(name) {
		t.Fatal("isolated database name guard")
	}
	t.Log("isolated_database=" + name)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal("Isolated access acceptance failed; private details suppressed")
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
	if d.DBName == name {
		t.Fatal("source database cannot be the isolated database")
	}
	d.DBName = ""
	d.ParseTime = true
	admin, err := sql.Open("mysql", d.FormatDSN())
	must(err)
	defer admin.Close()
	_, err = admin.Exec("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
	must(err)
	defer func() { _, err := admin.Exec("DROP DATABASE `" + name + "`"); must(err) }()
	d.DBName = name
	c, err := config.Load("config.example.yaml")
	must(err)
	c.Database.DSN = d.FormatDSN()
	c.Database.AutoMigrate = true
	c.Mode = "api"
	c.Auth.Token = "synthetic-access-acceptance-backend-only-123456"
	for k, p := range c.Providers {
		p.APIKey = ""
		c.Providers[k] = p
	}
	root := t.TempDir()
	t.Log("isolated_temp_root=" + root)
	packs := filepath.Join(root, "packs")
	must(os.Mkdir(packs, 0700))
	hash, err := accounts.Hash("synthetic-access-test-only")
	must(err)
	server := httptest.NewUnstartedServer(http.NewServeMux())
	c.Portal = config.Portal{Enabled: true, Origin: "http://" + server.Listener.Addr().String(), PacksDir: packs, AssetsDir: filepath.Join(root, "assets"), SessionTTL: time.Hour, MaxPackBytes: c.Server.MaxBodyBytes, ParticipantsEnabled: true, EntryMode: "link", InvitationMode: "code", ParticipantReports: "allow", ModelLabel: "synthetic isolated model", PollInterval: time.Second, LoginLimit: 1000, LoginWindow: time.Minute, AdminPasswordHash: hash}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	c.Server.Listen = listener.Addr().String()
	must(listener.Close())
	configBytes, err := yaml.Marshal(c)
	must(err)
	privateConfig := filepath.Join(root, "acceptance.yaml")
	must(os.WriteFile(privateConfig, configBytes, 0600))
	_, err = config.Load(privateConfig)
	must(err)
	backup := filepath.Join(root, "schema3-backup")
	runMaint := func(operation string, success bool) {
		t.Helper()
		cmd := exec.Command(*accessMaintBinary, operation, "-config", privateConfig, "-backup", backup, "-isolated")
		out, err := cmd.CombinedOutput()
		if success && err != nil {
			t.Fatalf("isolated %s failed; private detail suppressed", operation)
		}
		if !success && (err == nil || !bytes.Contains(out, []byte("STALE_BACKUP_REFUSED"))) {
			t.Fatal("stale backup was not explicitly refused")
		}
	}
	must(os.Mkdir(c.Portal.AssetsDir, 0700))
	// Handler construction requires real assets but the API test never needs model code or public content.
	for _, n := range []string{"practice-expert-interview-spa.html", "practice-expert-worker.js"} {
		must(os.WriteFile(filepath.Join(c.Portal.AssetsDir, n), []byte("synthetic access fixture"), 0600))
	}
	s, err := store.Open(context.Background(), c)
	must(err)
	db, err := s.DB.DB()
	must(err)
	var accountBefore string
	must(db.QueryRow("SELECT password_hash FROM tw_accounts WHERE username='admin'").Scan(&accountBefore))
	_, err = db.Exec("DROP TABLE tw_publisher_keys")
	must(err)
	_, err = db.Exec("DROP TABLE tw_pack_access")
	must(err)
	_, err = db.Exec("UPDATE tw_schema SET version=3")
	must(err)
	must(s.Close())
	if *accessMaintBinary != "" {
		runMaint("backup", true)
	}
	s, err = store.Open(context.Background(), c)
	must(err)
	defer s.Close()
	db, err = s.DB.DB()
	must(err)
	var version int
	must(db.QueryRow("SELECT version FROM tw_schema").Scan(&version))
	if version != 5 {
		t.Fatal("schema3 to schema5 migration failed")
	}
	var accountAfter string
	must(db.QueryRow("SELECT password_hash FROM tw_accounts WHERE username='admin'").Scan(&accountAfter))
	if accountBefore != accountAfter {
		t.Fatal("migration changed account")
	}
	var rows int
	must(db.QueryRow("SELECT COUNT(*) FROM tw_pack_access").Scan(&rows))
	if rows != 0 {
		t.Fatal("migration generated credentials")
	}
	if *accessMaintBinary != "" {
		runMaint("guard", true)
		must(s.Close())
		runMaint("restore", true)
		restored, err := sql.Open("mysql", d.FormatDSN())
		must(err)
		must(restored.QueryRow("SELECT version FROM tw_schema").Scan(&version))
		if version != 3 {
			t.Fatal("full schema3 restore failed")
		}
		must(restored.Close())
		if *accessOldBinary != "" {
			func() {
				ctx, cancel := context.WithCancel(context.Background())
				cmd := exec.CommandContext(ctx, *accessOldBinary, "serve", "-c", privateConfig)
				must(cmd.Start())
				done := make(chan error, 1)
				go func() { done <- cmd.Wait() }()
				defer func() {
					cancel()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("owned old binary did not exit")
					}
				}()
				ready := false
				client := http.Client{Timeout: time.Second}
				for n := 0; n < 40; n++ {
					res, err := client.Get("http://" + c.Server.Listen + "/health")
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
					t.Fatal("old binary not healthy after full schema3 restore")
				}
			}()
		}
		s, err = store.Open(context.Background(), c)
		must(err)
		defer s.Close()
		db, err = s.DB.DB()
		must(err)
	}
	handler, err := service.Handler(s)
	must(err)
	server.Config.Handler = handler
	server.Start()
	defer server.Close()
	jar, err := cookiejar.New(nil)
	must(err)
	client := &http.Client{Jar: jar, Timeout: 15 * time.Second}
	request := func(method, path string, body []byte, want int, authenticated bool) []byte {
		t.Helper()
		req, err := http.NewRequest(method, c.Portal.Origin+path, bytes.NewReader(body))
		must(err)
		req.Header.Set("Origin", c.Portal.Origin)
		req.Header.Set("Content-Type", "application/json")
		transport := client
		if !authenticated {
			transport = &http.Client{Timeout: 15 * time.Second}
		}
		res, err := transport.Do(req)
		must(err)
		defer res.Body.Close()
		out, err := io.ReadAll(res.Body)
		must(err)
		if res.StatusCode != want {
			t.Fatalf("unexpected status for %s %s: %d", method, path, res.StatusCode)
		}
		return out
	}
	request("POST", "/admin/api/login", []byte(`{"username":"admin","password":"synthetic-access-test-only"}`), 200, true)
	payload := []byte(`{"schemaVersion":1,"fieldnoteId":"FN-access","publicFieldnoteId":"FN-access","goal":"synthetic goal","profile":{"name":"synthetic","industry":"synthetic","role":"synthetic","stage":"synthetic","experience":"synthetic"},"questions":[{"id":"Q01","question":"synthetic question"}],"questionPackMeta":{"version":1},"interviewPolicy":{"scope":"per_question","maxFollowups":0}}`)
	type receipt struct {
		Key    string
		Hash   string
		URL    string
		Access struct {
			Code            string
			Status          string
			Source          string
			Revision        int64
			PublicationHash string `json:"publication_hash"`
		}
	}
	var first receipt
	must(json.Unmarshal(request("POST", "/admin/api/packs/FN-access-v1", payload, 201, true), &first))
	if len(first.Access.Code) != 40 || first.Access.Source != "worker" {
		t.Fatal("server receipt did not contain generated access")
	}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var repeat receipt
			must(json.Unmarshal(request("POST", "/admin/api/packs/FN-access-v1", payload, 201, true), &repeat))
			if repeat.Access.Code != first.Access.Code || repeat.Hash != first.Hash {
				t.Error("concurrent retry changed receipt")
			}
		}()
	}
	wg.Wait()
	request("GET", "/admin/api/packs/FN-access-v1/access", nil, 401, false)
	if bytes.Contains(request("GET", "/admin/api/packs", nil, 200, true), []byte(first.Access.Code)) {
		t.Fatal("pack list leaked invitation")
	}
	request("POST", "/portal/api/session", []byte(`{"key":"FN-access-v1","code":"wrong-synthetic"}`), 401, false)
	body, _ := json.Marshal(map[string]string{"key": "FN-access-v1", "code": first.Access.Code})
	participant := request("POST", "/portal/api/session", body, 200, false)
	if bytes.Contains(participant, []byte(first.Access.Code)) {
		t.Fatal("public session leaked invitation")
	}
	legacyPayload := bytes.Replace(payload, []byte(`"fieldnoteId":"FN-access","publicFieldnoteId":"FN-access"`), []byte(`"fieldnoteId":"FN-legacy-access","publicFieldnoteId":"FN-legacy-access","invitation":{"code":"synthetic-legacy-code","status":"active","createdAt":"synthetic"}`), 1)
	var legacy receipt
	must(json.Unmarshal(request("POST", "/admin/api/packs/FN-legacy-access-v1", legacyPayload, 201, true), &legacy))
	if legacy.Access.Code != "synthetic-legacy-code" || legacy.Access.Source != "legacy" {
		t.Fatal("legacy credential changed")
	}
	must(db.QueryRow("SELECT COUNT(*) FROM tw_pack_access WHERE pack_key='FN-legacy-access-v1'").Scan(&rows))
	if rows != 0 {
		t.Fatal("legacy automatically migrated")
	}
	manualPayload := bytes.Replace(payload, []byte(`"FN-access"`), []byte(`"FN-manual"`), 2)
	must(os.WriteFile(filepath.Join(packs, "FN-manual-v1.json"), manualPayload, 0600))
	var missing receipt
	must(json.Unmarshal(request("GET", "/admin/api/packs/FN-manual-v1/access", nil, 200, true), &missing))
	if missing.Access.Code != "" || missing.Access.Status != "missing" {
		t.Fatal("read initialized missing access")
	}
	manualBody, _ := json.Marshal(map[string]any{"action": "create", "revision": 0, "publication_hash": missing.Access.PublicationHash})
	request("POST", "/admin/api/packs/FN-manual-v1/access", manualBody, 401, false)
	var created receipt
	must(json.Unmarshal(request("POST", "/admin/api/packs/FN-manual-v1/access", manualBody, 200, true), &created))
	if len(created.Access.Code) != 40 {
		t.Fatal("explicit admin creation failed")
	}
	checkResponse, err := client.Get(c.Portal.Origin + "/admin/api/packs/FN-access-v1/access")
	must(err)
	checkResponse.Body.Close()
	if checkResponse.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("secret response was cacheable")
	}
	rotate := func(action string, revision int64, want int) receipt {
		body, _ := json.Marshal(map[string]any{"action": action, "revision": revision, "publication_hash": first.Hash})
		raw := request("POST", "/admin/api/packs/FN-access-v1/access", body, want, true)
		var result receipt
		if want == 200 {
			must(json.Unmarshal(raw, &result))
		}
		return result
	}
	changed := rotate("rotate", first.Access.Revision, 200)
	if changed.Access.Code == first.Access.Code || len(changed.Access.Code) != 40 {
		t.Fatal("explicit rotation failed")
	}
	request("POST", "/portal/api/session", body, 401, false)
	rotate("revoke", first.Access.Revision, 409)
	revoked := rotate("revoke", changed.Access.Revision, 200)
	if revoked.Access.Status != "revoked" {
		t.Fatal("explicit revocation failed")
	}
	var retry receipt
	must(json.Unmarshal(request("POST", "/admin/api/packs/FN-access-v1", payload, 201, true), &retry))
	if retry.Access.Status != "revoked" {
		t.Fatal("retry reactivated revoked access")
	}
	var calls int
	must(db.QueryRow("SELECT COUNT(*) FROM tw_calls").Scan(&calls))
	if calls != 0 {
		t.Fatal("model call occurred")
	}
	if *accessMaintBinary != "" {
		runMaint("restore", false)
		must(db.QueryRow("SELECT version FROM tw_schema").Scan(&version))
		must(db.QueryRow("SELECT COUNT(*) FROM tw_pack_access").Scan(&rows))
		if version != 5 || rows != 2 {
			t.Fatal("stale restore damaged new access data")
		}
	}
	if *accessFallbackBinary != "" {
		func() {
			active := rotate("rotate", revoked.Access.Revision, 200)
			fallback := c
			fallback.Portal.Origin = "http://" + fallback.Server.Listen
			raw, err := yaml.Marshal(fallback)
			must(err)
			p := filepath.Join(root, "fallback.yaml")
			must(os.WriteFile(p, raw, 0600))
			ctx, cancel := context.WithCancel(context.Background())
			cmd := exec.CommandContext(ctx, *accessFallbackBinary, "serve", "-c", p)
			must(cmd.Start())
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			defer func() {
				cancel()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Error("owned fallback did not exit")
				}
			}()
			transport := http.Client{Timeout: time.Second}
			ready := false
			for n := 0; n < 40; n++ {
				res, err := transport.Get(fallback.Portal.Origin + "/health")
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
				t.Fatal("schema5 compatible UI rollback not healthy")
			}
			res, err := transport.Get(fallback.Portal.Origin + "/admin/management.js")
			must(err)
			management, err := io.ReadAll(res.Body)
			res.Body.Close()
			must(err)
			if bytes.Contains(management, []byte("loadPublisherKeys")) {
				t.Fatal("fallback did not select earlier management UI")
			}
			body, _ := json.Marshal(map[string]string{"key": "FN-access-v1", "code": active.Access.Code})
			req, err := http.NewRequest("POST", fallback.Portal.Origin+"/portal/api/session", bytes.NewReader(body))
			must(err)
			req.Header.Set("Origin", fallback.Portal.Origin)
			req.Header.Set("Content-Type", "application/json")
			response, err := transport.Do(req)
			must(err)
			content, err := io.ReadAll(response.Body)
			response.Body.Close()
			must(err)
			if response.StatusCode != 200 || bytes.Contains(content, []byte(active.Access.Code)) {
				t.Fatal("fallback lost managed link or leaked invitation")
			}
			must(db.QueryRow("SELECT version FROM tw_schema").Scan(&version))
			must(db.QueryRow("SELECT COUNT(*) FROM tw_calls").Scan(&calls))
			if version != 5 || calls != 0 {
				t.Fatal("fallback changed schema or called model")
			}
			t.Log("schema5-compatible earlier UI keeps managed links and data; no SQL restore, no model calls; native Key uploads remain in the compatible backend")
		}()
	}
	if *accessOldBinary != "" {
		oldConfig, err := yaml.Marshal(c)
		must(err)
		p := filepath.Join(root, "old-api.yaml")
		must(os.WriteFile(p, oldConfig, 0600))
		_, err = config.Load(p)
		must(err)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, *accessOldBinary, "serve", "-c", p)
		out, err := cmd.CombinedOutput()
		if err == nil || ctx.Err() != nil || !bytes.Contains(out, []byte("结构版本")) {
			t.Fatal("schema3 binary did not reject schema5")
		}
	}
	t.Log("schema3->5 preserves account; no credential backfill; server receipt and 8 concurrent retries stable; legacy preserved; wrong/revoked codes rejected; admin-only visibility; model calls0; full schema3 restore and old binary health before writes; stale restore refused after business/access writes; disposable database removed by deferred cleanup")
}
