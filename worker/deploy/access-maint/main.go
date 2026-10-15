// access-maint makes private schema3 backups and refuses stale schema4 restores.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	driver "github.com/go-sql-driver/mysql"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"
)

type table struct {
	Rows int64  `json:"rows"`
	SHA  string `json:"sha256"`
}
type snapshot struct {
	Database string            `json:"database"`
	Schema   int               `json:"schema"`
	Tables   map[string]table  `json:"tables"`
	Files    map[string]string `json:"files"`
	DumpSHA  string            `json:"dump_sha256,omitempty"`
}

var ident = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)

func check(err error) {
	if err != nil {
		panic(errors.New("maintenance operation failed; private details suppressed"))
	}
}
func require(ok bool, message string) {
	if !ok {
		panic(errors.New(message))
	}
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func tables(db *sql.DB, name string) map[string]table {
	rows, err := db.Query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", name)
	check(err)
	var names []string
	for rows.Next() {
		var n string
		check(rows.Scan(&n))
		require(ident.MatchString(n) && strings.HasPrefix(n, "tw_"), "dedicated Worker database required")
		names = append(names, n)
	}
	check(rows.Err())
	rows.Close()
	result := map[string]table{}
	for _, name := range names {
		keys, err := db.Query("SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION", name)
		check(err)
		var pk []string
		for keys.Next() {
			var k string
			check(keys.Scan(&k))
			require(ident.MatchString(k), "safe primary key required")
			pk = append(pk, "`"+k+"`")
		}
		check(keys.Err())
		keys.Close()
		require(len(pk) > 0, "primary key required")
		rr, err := db.Query("SELECT * FROM `" + name + "` ORDER BY " + strings.Join(pk, ","))
		check(err)
		cols, err := rr.Columns()
		check(err)
		h := sha256.New()
		var count int64
		for rr.Next() {
			values := make([]any, len(cols))
			ptr := make([]any, len(cols))
			for i := range values {
				ptr[i] = &values[i]
			}
			check(rr.Scan(ptr...))
			for _, value := range values {
				var b []byte
				switch v := value.(type) {
				case nil:
					b = []byte{0}
				case []byte:
					b = append([]byte{1}, v...)
				case time.Time:
					b = []byte("t" + v.UTC().Format(time.RFC3339Nano))
				default:
					b = []byte(fmt.Sprintf("%T:%v", v, v))
				}
				check(binary.Write(h, binary.BigEndian, uint64(len(b))))
				_, _ = h.Write(b)
			}
			count++
		}
		check(rr.Err())
		rr.Close()
		result[name] = table{count, hex.EncodeToString(h.Sum(nil))}
	}
	return result
}
func state(db *sql.DB, d *driver.Config, c config.Config, path string) snapshot {
	out := snapshot{Database: d.DBName, Tables: tables(db, d.DBName), Files: map[string]string{}}
	check(db.QueryRow("SELECT version FROM tw_schema").Scan(&out.Schema))
	raw, err := os.ReadFile(path)
	check(err)
	out.Files[path] = digest(raw)
	check(filepath.WalkDir(c.Portal.PacksDir, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.Type()&os.ModeSymlink != 0 {
			return errors.New("publication link refused")
		}
		if !e.IsDir() {
			raw, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			out.Files[p] = digest(raw)
		}
		return nil
	}))
	return out
}
func option(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`).Replace(v) + `"`
}
func private(path string, b []byte) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	check(err)
	_, err = f.Write(b)
	check(err)
	check(f.Sync())
	check(f.Close())
}
func allowed(before, after snapshot) bool {
	if before.Schema != 3 || after.Schema != 4 || before.Database != after.Database || !reflect.DeepEqual(before.Files, after.Files) {
		return false
	}
	for name, want := range before.Tables {
		if name != "tw_schema" && after.Tables[name] != want {
			return false
		}
	}
	for name, current := range after.Tables {
		if _, exists := before.Tables[name]; !exists && (name != "tw_pack_access" || current.Rows != 0) {
			return false
		}
	}
	return true
}
func run() {
	require(len(os.Args) > 1, "operation required: backup, guard or restore")
	mode := os.Args[1]
	args := flag.NewFlagSet("access-maint", flag.ContinueOnError)
	args.SetOutput(os.Stderr)
	path := args.String("config", "", "existing private Worker config")
	backup := args.String("backup", "", "new absolute private backup directory")
	container := args.String("mysql-container", "mysql", "existing MySQL container")
	isolated := args.Bool("isolated", false, "only for random tw_access_accept_ databases")
	check(args.Parse(os.Args[2:]))
	require(*path != "" && filepath.IsAbs(*backup) && filepath.Clean(*backup) == *backup, "explicit config and absolute clean backup path required")
	c, err := config.Load(*path)
	check(err)
	d, err := driver.ParseDSN(c.Database.DSN)
	check(err)
	require(d.DBName != "" && ident.MatchString(d.DBName), "dedicated database required")
	d.ParseTime = true
	d.Loc = time.UTC
	if *isolated {
		require(strings.HasPrefix(d.DBName, "tw_access_accept_") && strings.HasPrefix(*backup, os.TempDir()+string(os.PathSeparator)), "isolated scope refused")
	} else {
		require(strings.HasPrefix(*backup, "/data/teaching-worker/deploy-backups/access-"), "production backup scope refused")
	}
	db, err := sql.Open("mysql", d.FormatDSN())
	check(err)
	defer db.Close()
	db.SetMaxOpenConns(2)
	current := state(db, d, c, *path)
	switch mode {
	case "backup":
		require(current.Schema == 3, "backup requires schema3")
		var active int64
		check(db.QueryRow("SELECT COUNT(*) FROM tw_tasks WHERE status IN ('queued','running')").Scan(&active))
		require(active == 0, "idle queue required")
		check(os.Mkdir(*backup, 0700))
		defaults := "[client]\nuser=" + option(d.User) + "\npassword=" + option(d.Passwd) + "\nhost=127.0.0.1\nport=3306\nprotocol=TCP\n"
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "docker", "exec", "-i", *container, "mysqldump", "--defaults-extra-file=/dev/stdin", "--single-transaction", "--skip-lock-tables", "--skip-extended-insert", "--complete-insert", "--order-by-primary", "--routines", "--events", "--triggers", "--hex-blob", "--no-tablespaces", "--set-gtid-purged=OFF", "--column-statistics=0", d.DBName)
		cmd.Stdin = strings.NewReader(defaults)
		var diag bytes.Buffer
		cmd.Stderr = &diag
		dump, err := cmd.Output()
		check(err)
		require(reflect.DeepEqual(current, state(db, d, c, *path)), "backup changed while service live")
		current.DumpSHA = digest(dump)
		private(filepath.Join(*backup, "database.sql"), dump)
		raw, err := json.Marshal(current)
		check(err)
		private(filepath.Join(*backup, "snapshot.json"), raw)
		fmt.Println(`{"backup_schema":3,"private_sql_snapshot":true,"business_rows_unchanged":true}`)
	case "guard", "restore":
		raw, err := os.ReadFile(filepath.Join(*backup, "snapshot.json"))
		check(err)
		var before snapshot
		check(json.Unmarshal(raw, &before))
		require(allowed(before, current), "STALE_BACKUP_REFUSED: business writes or access credentials exist")
		if mode == "guard" {
			fmt.Println(`{"schema3_restore_allowed":true,"new_business_writes":false}`)
			return
		}
		if !*isolated {
			out, err := exec.Command("systemctl", "is-active", "teaching-worker.service").Output()
			require(err != nil && strings.TrimSpace(string(out)) == "inactive", "stop all Worker writers before restore")
		}
		dump, err := os.ReadFile(filepath.Join(*backup, "database.sql"))
		check(err)
		require(digest(dump) == before.DumpSHA, "backup checksum mismatch")
		require(allowed(before, state(db, d, c, *path)), "STALE_BACKUP_REFUSED: state changed before restore")
		_, err = db.Exec("DROP TABLE tw_pack_access")
		check(err)
		restoreDSN := d.Clone()
		restoreDSN.MultiStatements = true
		restore, err := sql.Open("mysql", restoreDSN.FormatDSN())
		check(err)
		defer restore.Close()
		_, err = restore.Exec(string(dump))
		check(err)
		final := state(db, d, c, *path)
		before.DumpSHA = ""
		require(reflect.DeepEqual(before, final), "restored schema3 fingerprint mismatch")
		fmt.Println(`{"restored_schema":3,"all_original_rows_and_publications_preserved":true}`)
	default:
		panic(errors.New("unknown operation"))
	}
}
func main() {
	defer func() {
		if p := recover(); p != nil {
			if err, ok := p.(error); ok {
				fmt.Fprintln(os.Stderr, err)
			} else {
				fmt.Fprintln(os.Stderr, "maintenance failed")
			}
			os.Exit(1)
		}
	}()
	run()
}
