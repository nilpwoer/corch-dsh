// Package store 通过 GORM/MySQL 保存任务、输入版本和短事务租约。
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/runtimecfg"
	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

//go:embed schema.sql
var schema string

//go:embed portal-schema.sql
var portalSchema string

//go:embed runtime-schema.sql
var runtimeSchema string

//go:embed access-schema.sql
var accessSchema string

type Store struct {
	DB     *gorm.DB
	Config config.Config
}
type Task struct {
	ID            string          `json:"id"`
	InterviewID   string          `json:"interview_id"`
	Kind          string          `json:"kind"`
	FollowupKey   *string         `json:"-"`
	Input         json.RawMessage `json:"-"`
	ReleaseData   json.RawMessage `json:"-"`
	ReportVersion int64           `json:"report_version,omitempty"`
	Status        string          `json:"status"`
	Attempt       int             `json:"attempt"`
	MaxAttempts   int             `json:"-"`
	ClaimToken    *string         `json:"-"`
	LeaseUntil    *time.Time      `json:"-"`
	AvailableAt   time.Time       `json:"-"`
	Options       json.RawMessage `json:"-"`
	Output        json.RawMessage `json:"output"`
	ErrorCode     *string         `json:"error_code"`
	CreatedAt     time.Time       `json:"created_at"`
}

func (Task) TableName() string { return "tw_tasks" }

type interview struct {
	ID              string
	InputVersion    int64
	InputHash       string
	Frozen          bool
	ReportVersion   int64
	FollowupRelease json.RawMessage
}

func (interview) TableName() string { return "tw_interviews" }

type request struct {
	RequestKey string
	InputHash  string
	TaskID     string
}

func (request) TableName() string { return "tw_requests" }

// Input 保存业务快照及此前已经发布的追问，不保存请求密钥。
type Input struct {
	Submit    domain.Submit     `json:"submit"`
	Followups []domain.Followup `json:"followups"`
}
type followed struct {
	TaskID       string
	InterviewID  string
	QuestionID   string
	InputVersion int64
	Text         string
}

func (followed) TableName() string { return "tw_followups" }

type stage struct {
	TaskID string
	Stage  string
	Output json.RawMessage
}

func (stage) TableName() string { return "tw_stages" }

type Call struct {
	ID        string
	TaskID    string
	Stage     string
	Request   json.RawMessage
	Response  string
	ErrorCode *string
}

func (Call) TableName() string { return "tw_calls" }

func Open(ctx context.Context, c config.Config) (*Store, error) {
	dsn, err := driver.ParseDSN(c.Database.DSN)
	if err != nil {
		return nil, fmt.Errorf("MySQL DSN 格式无效")
	}
	if dsn.DBName == "" {
		return nil, fmt.Errorf("MySQL DSN 必须指定独立数据库")
	}
	dsn.ParseTime = true
	dsn.Loc = time.UTC
	dsn.Timeout = c.Database.ConnectTimeout
	dsn.ReadTimeout = c.Database.ConnectTimeout
	dsn.WriteTimeout = c.Database.ConnectTimeout
	db, err := gorm.Open(mysql.Open(dsn.FormatDSN()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), DisableAutomaticPing: true})
	if err != nil {
		return nil, fmt.Errorf("连接 MySQL 失败")
	}
	pool, err := db.DB()
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(c.Database.MaxOpenConns)
	pool.SetMaxIdleConns(c.Database.MaxIdleConns)
	pool.SetConnMaxLifetime(c.Database.ConnMaxLifetime)
	s := &Store{DB: db, Config: c}
	startup, cancel := context.WithTimeout(ctx, c.Database.ConnectTimeout)
	defer cancel()
	if err = pool.PingContext(startup); err == nil {
		err = s.migrate(startup, dsn.DBName)
	}
	if err == nil {
		err = s.registerReleases(startup)
	}
	if err == nil && c.Portal.Enabled {
		err = s.InitializeAdmin(startup)
	}
	if err != nil {
		_ = pool.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error {
	db, err := s.DB.DB()
	if err != nil {
		return err
	}
	return db.Close()
}
func (s *Store) migrate(ctx context.Context, name string) error {
	db, err := s.DB.DB()
	if err != nil {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var version string
	if err = conn.QueryRowContext(ctx, "SELECT VERSION()").Scan(&version); err != nil {
		return err
	}
	parts := strings.Split(version, ".")
	major, _ := strconv.Atoi(parts[0])
	minor, patch := 0, 0
	if len(parts) >= 3 {
		minor, _ = strconv.Atoi(parts[1])
		patch, _ = strconv.Atoi(strings.Split(parts[2], "-")[0])
	}
	if major < 8 || major == 8 && minor == 0 && patch < 13 || strings.Contains(strings.ToLower(version), "mariadb") {
		return fmt.Errorf("需要 MySQL 8.0.13 或更新版本")
	}
	lock := "tw_schema_" + config.Hash(name)[:32]
	var acquired int
	lockTimeout := s.Config.Database.ConnectTimeout.Seconds()
	if err = conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", lock, lockTimeout).Scan(&acquired); err != nil {
		return err
	}
	if acquired != 1 {
		return fmt.Errorf("数据库结构初始化锁获取失败")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), s.Config.Database.ConnectTimeout)
		defer cancel()
		_, _ = conn.ExecContext(cleanup, "SELECT RELEASE_LOCK(?)", lock)
	}()
	if c := s.Config.Database; c.AutoMigrate {
		if _, err = conn.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS tw_schema (version INT PRIMARY KEY) ENGINE=InnoDB"); err != nil {
			return err
		}
	}
	rows, err := conn.QueryContext(ctx, "SELECT version FROM tw_schema")
	if err != nil {
		return fmt.Errorf("读取结构版本失败；首次启动须启用 database.auto_migrate")
	}
	var versions []int
	for rows.Next() {
		var v int
		if err = rows.Scan(&v); err != nil {
			_ = rows.Close()
			return err
		}
		versions = append(versions, v)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	if len(versions) > 1 || len(versions) == 1 && versions[0] != 1 && versions[0] != 2 && versions[0] != 3 && versions[0] != 4 {
		return fmt.Errorf("不支持的 Worker 数据库结构版本")
	}
	if len(versions) == 1 && versions[0] == 4 {
		return nil
	}
	if !s.Config.Database.AutoMigrate {
		return fmt.Errorf("数据库尚未初始化")
	}
	ddl := accessSchema
	if len(versions) == 1 && versions[0] == 2 {
		ddl = runtimeSchema + "\n" + accessSchema
	}
	if len(versions) == 1 && versions[0] == 1 {
		ddl = portalSchema + "\n" + runtimeSchema + "\n" + accessSchema
	}
	if len(versions) == 0 {
		ddl = schema + "\n" + portalSchema + "\n" + runtimeSchema + "\n" + accessSchema
	}
	for _, statement := range strings.Split(ddl, ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err = conn.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("初始化 Worker 数据表: %w", err)
			}
		}
	}
	if len(versions) == 1 {
		_, err = conn.ExecContext(ctx, "UPDATE tw_schema SET version=4")
	} else {
		_, err = conn.ExecContext(ctx, "INSERT INTO tw_schema(version) VALUES (4)")
	}
	return err
}
func (s *Store) registerReleases(ctx context.Context) error {
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, kind := range []string{"followup", "report"} {
			r := s.Config.Release(kind)
			id := kind + ":" + r.Pipeline.Version
			if err := tx.Exec("INSERT INTO tw_releases(id,hash,contents) VALUES (?,?,?) ON DUPLICATE KEY UPDATE id=id", id, r.Hash, encode(r)).Error; err != nil {
				return err
			}
			var hash string
			if err := tx.Raw("SELECT hash FROM tw_releases WHERE id=?", id).Scan(&hash).Error; err != nil {
				return err
			}
			if hash != r.Hash {
				return fmt.Errorf("提示词版本 %s 的内容已经变化，请设置新的 version", id)
			}
		}
		return nil
	})
}

// Enqueue 将输入版本、幂等记录和任务一起提交。报告入队同时冻结访谈。
func (s *Store) Enqueue(ctx context.Context, key string, sub domain.Submit) (Task, error) {
	var task Task
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		hash := config.Hash(sub)
		// 先占有幂等键；重复请求的并发事务在这里等待原事务提交或回滚。
		taskID := uuid.NewString()
		if err := tx.Exec("INSERT INTO tw_requests(request_key,input_hash,task_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE request_key=request_key", key, hash, taskID).Error; err != nil {
			return err
		}
		var prior request
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("request_key=?", key).Take(&prior).Error; err != nil {
			return err
		}
		if prior.TaskID != taskID {
			if err := tx.Where("id=?", prior.TaskID).Take(&task).Error; err != nil {
				return err
			}
			if prior.InputHash != hash {
				// Historical digests include sourceRefs key order. Compare the retained input without rewriting its digest.
				var saved Input
				if err := json.Unmarshal(task.Input, &saved); err != nil {
					return err
				}
				if config.Hash(saved.Submit) != hash {
					return domain.Fail("IDEMPOTENCY_CONFLICT", 409)
				}
			}
			return nil
		}
		if prior.InputHash != hash {
			return domain.Fail("IDEMPOTENCY_CONFLICT", 409)
		}
		snap := sub.Snapshot
		snapHash := config.Hash(snap)
		followRelease := s.Config.Release("followup")
		if err := tx.Exec("INSERT INTO tw_interviews(id,input_version,input_hash,followup_release) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id", snap.InterviewID, snap.InputVersion, snapHash, encode(followRelease)).Error; err != nil {
			return err
		}
		var live interview
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id=?", snap.InterviewID).Take(&live).Error; err != nil {
			return err
		}
		frozen, err := frozenRuntime(tx, snap.InterviewID)
		if err != nil {
			return err
		}
		if frozen == nil {
			var snapshots int64
			if err := tx.Table("tw_snapshots").Where("interview_id=?", live.ID).Count(&snapshots).Error; err != nil {
				return err
			}
			var participants int64
			if err := tx.Model(&ParticipantSession{}).Where("interview_id=?", live.ID).Count(&participants).Error; err != nil {
				return err
			}
			value := runtimecfg.Resolve(s.Config, runtimecfg.Settings{}, runtimecfg.Settings{}, nil)
			if snapshots == 0 && participants == 0 {
				var err error
				value, _, _, err = s.readResolvedRuntime(tx, nil)
				if err != nil {
					return err
				}
				if err := tx.Model(&interview{}).Where("id=?", live.ID).Update("followup_release", encode(value.Followup)).Error; err != nil {
					return err
				}
			} else {
				// Existing interviews keep retained releases; new admin defaults never rewrite them.
				if err := json.Unmarshal(live.FollowupRelease, &value.Followup); err != nil {
					return err
				}
				var previous Task
				err := tx.Where("interview_id=? AND kind='report'", live.ID).Order("report_version,id").Take(&previous).Error
				if err == nil {
					if err := json.Unmarshal(previous.ReleaseData, &value.Report); err != nil {
						return err
					}
				} else if !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
			}
			value.Hash = ""
			value.Hash = config.Hash(value)
			if !value.Valid() {
				return domain.Fail("INVALID_FROZEN_RUNTIME", 500)
			}
			if err := tx.Create(&interviewRuntime{InterviewID: snap.InterviewID, Contents: encode(value)}).Error; err != nil {
				return err
			}
			frozen = &value
		}
		if snap.InputVersion < live.InputVersion {
			return domain.Fail("INPUT_VERSION_CONFLICT", 409)
		}
		if snap.InputVersion == live.InputVersion && snapHash != live.InputHash {
			var saved struct{ Contents json.RawMessage }
			if err := tx.Table("tw_snapshots").Where("interview_id=? AND input_version=?", live.ID, live.InputVersion).Take(&saved).Error; err != nil {
				return err
			}
			var previous domain.Snapshot
			if err := json.Unmarshal(saved.Contents, &previous); err != nil {
				return err
			}
			if config.Hash(previous) != snapHash {
				return domain.Fail("INPUT_VERSION_CONFLICT", 409)
			}
			// Preserve legacy metadata for an unchanged version; only a later version receives a new digest.
			snapHash = live.InputHash
		}
		if live.Frozen && (sub.Kind == "followup" || snap.InputVersion != live.InputVersion) {
			return domain.Fail("INTERVIEW_FROZEN", 409)
		}
		var followupKey *string
		if snap.InputVersion > live.InputVersion {
			var saved struct{ Contents json.RawMessage }
			if err := tx.Table("tw_snapshots").Where("interview_id=? AND input_version=?", live.ID, live.InputVersion).Take(&saved).Error; err != nil {
				return err
			}
			var previous domain.Snapshot
			if err := json.Unmarshal(saved.Contents, &previous); err != nil {
				return err
			}
			if config.Hash(previous.Pack) != config.Hash(snap.Pack) {
				return domain.Fail("QUESTION_PACK_MISMATCH", 409)
			}
		}
		if sub.Kind == "followup" {
			value := config.Hash([]any{live.ID, sub.QuestionID, snap.InputVersion})
			followupKey = &value
			err := tx.Where("followup_key=?", value).Take(&task).Error
			if err == nil {
				return tx.Model(&request{}).Where("request_key=?", key).Update("task_id", task.ID).Error
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		if err := tx.Exec("INSERT INTO tw_snapshots(interview_id,input_version,contents) VALUES (?,?,?) ON DUPLICATE KEY UPDATE input_version=input_version", snap.InterviewID, snap.InputVersion, encode(snap)).Error; err != nil {
			return err
		}
		changes := map[string]any{"input_version": snap.InputVersion, "input_hash": snapHash}
		if sub.Kind == "report" {
			live.ReportVersion++
			changes["frozen"] = true
			changes["report_version"] = live.ReportVersion
		}
		if err := tx.Model(&interview{}).Where("id=?", live.ID).Updates(changes).Error; err != nil {
			return err
		}
		var history []followed
		if err := tx.Where("interview_id=?", live.ID).Order("input_version,task_id").Find(&history).Error; err != nil {
			return err
		}
		in := Input{Submit: sub, Followups: []domain.Followup{}}
		for _, f := range history {
			in.Followups = append(in.Followups, domain.Followup{QuestionID: f.QuestionID, InputVersion: f.InputVersion, Text: f.Text})
		}
		release := frozen.Report
		if sub.Kind == "followup" {
			release = frozen.Followup
		}
		task = Task{ID: taskID, InterviewID: live.ID, Kind: sub.Kind, FollowupKey: followupKey, Input: encode(in), ReleaseData: encode(release), Status: "queued", MaxAttempts: frozen.Options.MaxAttempts, Options: encode(frozen.Options)}
		if sub.Kind == "report" {
			task.ReportVersion = live.ReportVersion
		}
		// 时间来自 MySQL，租约和调度不依赖各副本的本机时钟。
		return tx.Omit("AvailableAt", "CreatedAt").Create(&task).Error
	}, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return Task{}, err
	}
	return s.Get(ctx, task.ID)
}
func (s *Store) Get(ctx context.Context, id string) (Task, error) {
	var task Task
	err := s.DB.WithContext(ctx).Where("id=?", id).Take(&task).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return task, domain.Fail("NOT_FOUND", 404)
	}
	return task, err
}
func (s *Store) List(ctx context.Context, id string) ([]Task, error) {
	var tasks []Task
	err := s.DB.WithContext(ctx).Where("interview_id=?", id).Order("created_at,id").Find(&tasks).Error
	return tasks, err
}

// Claim 使用 SKIP LOCKED 分配租约；替代执行获得新的 claim_token。
func (s *Store) Claim(ctx context.Context, kind string) (*Task, error) {
	var task Task
	found := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).Where("kind=? AND ((status='queued' AND available_at<=UTC_TIMESTAMP(6)) OR (status='running' AND lease_until<=UTC_TIMESTAMP(6)))", kind).Order("created_at,id").Take(&task).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if task.Attempt >= task.MaxAttempts {
			return tx.Model(&Task{}).Where("id=?", task.ID).Updates(map[string]any{"status": "failed", "error_code": "ATTEMPTS_EXHAUSTED", "claim_token": nil, "lease_until": nil}).Error
		}
		var options config.Queue
		if err = json.Unmarshal(task.Options, &options); err != nil || options.LeaseDuration <= 0 || options.HeartbeatInterval <= 0 || options.TaskTimeout <= 0 {
			return tx.Model(&Task{}).Where("id=?", task.ID).Updates(map[string]any{"status": "failed", "error_code": "INVALID_TASK_DATA", "claim_token": nil, "lease_until": nil}).Error
		}
		token := uuid.NewString()
		task.ClaimToken = &token
		task.Attempt++
		task.Status = "running"
		task.ErrorCode = nil
		result := tx.Model(&Task{}).Where("id=?", task.ID).Updates(map[string]any{"status": "running", "attempt": task.Attempt, "claim_token": token, "error_code": nil, "lease_until": gorm.Expr("UTC_TIMESTAMP(6) + INTERVAL ? MICROSECOND", options.LeaseDuration.Microseconds())})
		found = result.Error == nil
		return result.Error
	}, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil || !found {
		return nil, err
	}
	return &task, nil
}
func owned(tx *gorm.DB, t Task) *gorm.DB {
	return tx.Model(&Task{}).Where("id=? AND status='running' AND claim_token=? AND lease_until>UTC_TIMESTAMP(6)", t.ID, t.ClaimToken)
}
func (s *Store) Heartbeat(ctx context.Context, t Task, lease time.Duration) error {
	result := owned(s.DB.WithContext(ctx), t).Update("lease_until", gorm.Expr("UTC_TIMESTAMP(6) + INTERVAL ? MICROSECOND", lease.Microseconds()))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return domain.Fail("CLAIM_LOST", 409)
	}
	return nil
}
func (s *Store) Stage(ctx context.Context, t Task, name string) (json.RawMessage, error) {
	var st stage
	err := s.DB.WithContext(ctx).Where("task_id=? AND stage=?", t.ID, name).Take(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return st.Output, err
}
func (s *Store) Checkpoint(ctx context.Context, t Task, name string, output any) error {
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current Task
		if err := owned(tx, t).Clauses(clause.Locking{Strength: "UPDATE"}).Take(&current).Error; err != nil {
			return domain.Fail("CLAIM_LOST", 409)
		}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&stage{TaskID: t.ID, Stage: name, Output: encode(output)}).Error
	})
}
func (s *Store) Finish(ctx context.Context, t Task, result any) error {
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var live interview
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id=?", t.InterviewID).Take(&live).Error; err != nil {
			return err
		}
		var in Input
		var release config.Release
		if err := json.Unmarshal(t.Input, &in); err != nil {
			return err
		}
		if err := json.Unmarshal(t.ReleaseData, &release); err != nil {
			return err
		}
		status := "succeeded"
		if t.Kind == "followup" && (live.Frozen || live.InputVersion != in.Submit.Snapshot.InputVersion) {
			status = "superseded"
			result = nil
		}
		if status == "succeeded" && t.Kind == "followup" {
			r := result.(domain.FollowupResult) // 同进程执行器只为追问任务返回此类型。
			if r.Status == "followup_ready" {
				var count int64
				if err := tx.Model(&followed{}).Where("interview_id=? AND question_id=?", live.ID, in.Submit.QuestionID).Count(&count).Error; err != nil {
					return err
				}
				var publishedHistory []followed
				if err := tx.Where("interview_id=?", live.ID).Find(&publishedHistory).Error; err != nil {
					return err
				}
				history := []domain.Followup{}
				for _, f := range publishedHistory {
					history = append(history, domain.Followup{QuestionID: f.QuestionID})
				}
				used, limit := domain.FollowupLimit(in.Submit.Snapshot, history, in.Submit.QuestionID, release.Pipeline.MaxFollowups)
				if used >= limit {
					result = domain.FollowupResult{Status: "needs_review", Reason: "FOLLOWUP_LIMIT", AllowSkip: true}
				} else {
					if err := tx.Create(&followed{TaskID: t.ID, InterviewID: live.ID, QuestionID: in.Submit.QuestionID, InputVersion: in.Submit.Snapshot.InputVersion, Text: r.Text}).Error; err != nil {
						return err
					}
				}
			}
		}
		updated := owned(tx, t).Updates(map[string]any{"status": status, "output": encode(result), "error_code": nil, "claim_token": nil, "lease_until": nil})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return domain.Fail("CLAIM_LOST", 409)
		}
		return nil
	})
}
func (s *Store) Fail(ctx context.Context, t Task, code string, retry bool, delay time.Duration) error {
	status := "failed"
	if retry {
		status = "queued"
	}
	r := owned(s.DB.WithContext(ctx), t).Updates(map[string]any{"status": status, "error_code": code, "claim_token": nil, "lease_until": nil, "available_at": gorm.Expr("UTC_TIMESTAMP(6) + INTERVAL ? MICROSECOND", delay.Microseconds())})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return domain.Fail("CLAIM_LOST", 409)
	}
	return nil
}
func (s *Store) StartCall(ctx context.Context, c Call) error {
	return s.DB.WithContext(ctx).Create(&c).Error
}
func (s *Store) EndCall(ctx context.Context, id, response string, code *string) error {
	return s.DB.WithContext(ctx).Model(&Call{}).Where("id=?", id).Updates(map[string]any{"response": response, "error_code": code}).Error
}
func encode(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
