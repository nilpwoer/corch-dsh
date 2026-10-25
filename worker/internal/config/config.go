// Package config 解析启动配置，并将提示词、模型和规则解析为可追溯的任务版本。
package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config 包含启动文件中的敏感值，不能整体输出到日志或任务记录。
type Config struct {
	Version   int                 `yaml:"version"`
	Mode      string              `yaml:"mode"`
	Server    Server              `yaml:"server"`
	Database  Database            `yaml:"database"`
	Auth      Auth                `yaml:"auth"`
	Queue     Queue               `yaml:"queue"`
	Providers map[string]Provider `yaml:"providers"`
	Prompts   map[string]Pipeline `yaml:"prompts"`
	Preview   Preview             `yaml:"preview"`
	Portal    Portal              `yaml:"portal"`
}

// Portal hosts authenticated package management independently of loopback preview.
type Portal struct {
	Enabled             bool          `yaml:"enabled"`
	AssetsDir           string        `yaml:"assets_dir"`
	PacksDir            string        `yaml:"packs_dir"`
	Origin              string        `yaml:"origin"`
	SessionTTL          time.Duration `yaml:"session_ttl"`
	MaxPackBytes        int64         `yaml:"max_pack_bytes"`
	AdminPasswordHash   string        `yaml:"admin_password_hash" json:"-"`
	LoginLimit          int           `yaml:"login_limit"`
	LoginWindow         time.Duration `yaml:"login_window"`
	ParticipantsEnabled bool          `yaml:"participants_enabled"`
	EntryMode           string        `yaml:"entry_mode"`
	InvitationMode      string        `yaml:"invitation_mode"`
	ParticipantReports  string        `yaml:"participant_reports"`
	PollInterval        time.Duration `yaml:"poll_interval"`
	ModelLabel          string        `yaml:"model_label"`
}

// Preview 是仅供本机联调的同源页面入口，不承担公开访谈身份认证。
type Preview struct {
	Enabled      bool          `yaml:"enabled"`
	AssetsDir    string        `yaml:"assets_dir"`
	PackFile     string        `yaml:"pack_file"`
	SessionTTL   time.Duration `yaml:"session_ttl"`
	PollInterval time.Duration `yaml:"poll_interval"`
	ModelLabel   string        `yaml:"model_label"`
}
type Server struct {
	Listen          string        `yaml:"listen"`
	ReadTimeout     time.Duration `yaml:"read_timeout"`
	WriteTimeout    time.Duration `yaml:"write_timeout"`
	ShutdownTimeout time.Duration `yaml:"shutdown_timeout"`
	MaxBodyBytes    int64         `yaml:"max_body_bytes"`
}
type Database struct {
	DSN             string        `yaml:"dsn"`
	AutoMigrate     bool          `yaml:"auto_migrate"`
	MaxOpenConns    int           `yaml:"max_open_conns"`
	MaxIdleConns    int           `yaml:"max_idle_conns"`
	ConnMaxLifetime time.Duration `yaml:"conn_max_lifetime"`
	ConnectTimeout  time.Duration `yaml:"connect_timeout"`
}
type Auth struct {
	Token string `yaml:"token"`
}
type Queue struct {
	FollowupConcurrency int           `yaml:"followup_concurrency"`
	ReportConcurrency   int           `yaml:"report_concurrency"`
	PollInterval        time.Duration `yaml:"poll_interval"`
	LeaseDuration       time.Duration `yaml:"lease_duration"`
	HeartbeatInterval   time.Duration `yaml:"heartbeat_interval"`
	TaskTimeout         time.Duration `yaml:"task_timeout"`
	MaxAttempts         int           `yaml:"max_attempts"`
	RetryDelay          time.Duration `yaml:"retry_delay"`
	MaxRetryDelay       time.Duration `yaml:"max_retry_delay"`
	MaxInputBytes       int           `yaml:"max_input_bytes"`
	MaxOutputBytes      int64         `yaml:"max_output_bytes"`
}
type Provider struct {
	BaseURL        string        `yaml:"base_url" json:"base_url"`
	APIKey         string        `yaml:"api_key" json:"-"`
	RequestTimeout time.Duration `yaml:"request_timeout" json:"request_timeout"`
}
type Model struct {
	Provider       string   `yaml:"provider" json:"provider"`
	Name           string   `yaml:"name" json:"name"`
	MaxTokens      int      `yaml:"max_tokens" json:"max_tokens"`
	Temperature    *float64 `yaml:"temperature" json:"temperature"`
	ResponseFormat string   `yaml:"response_format" json:"response_format"`
	Thinking       string   `yaml:"thinking" json:"thinking,omitempty"`
}
type Pipeline struct {
	Version        string `yaml:"version" json:"version"`
	Model          Model  `yaml:"model" json:"model"`
	MaxFollowups   int    `yaml:"max_followups" json:"max_followups"`
	MaxCorrections int    `yaml:"max_corrections,omitempty" json:"max_corrections,omitempty"`
	Analyze        string `yaml:"analyze" json:"analyze"`
	Compose        string `yaml:"compose" json:"compose"`
}

// Release 不包含密钥；入队保存完整内容，重试不读取新的提示词。
type Release struct {
	Kind     string   `json:"kind"`
	Pipeline Pipeline `json:"pipeline"`
	Provider Provider `json:"provider"`
	Hash     string   `json:"hash"`
}

// Load 在打开网络和数据库之前拒绝未知字段、缺失参数和无效配置。
func Load(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("读取配置文件: %w", err)
	}
	d := yaml.NewDecoder(bytes.NewReader(data))
	d.KnownFields(true)
	if err = d.Decode(&c); err != nil {
		return c, fmt.Errorf("解析配置: %w", err)
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return c, fmt.Errorf("配置只允许一个 YAML 文档")
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	bad := func(s string) error { return fmt.Errorf("配置错误: %s", s) }
	if c.Version != 1 {
		return bad("version 必须为 1")
	}
	if c.Mode != "api" && c.Mode != "worker" && c.Mode != "both" {
		return bad("mode 必须为 api/worker/both")
	}
	host, _, listenErr := net.SplitHostPort(c.Server.Listen)
	if listenErr != nil {
		return bad("server.listen 必须为 host:port")
	}
	if c.Preview.Enabled {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() || c.Mode == "worker" {
			return bad("preview 只允许在 api/both 模式监听回环 IP")
		}
		if c.Preview.AssetsDir == "" || c.Preview.PackFile == "" || c.Preview.SessionTTL <= 0 || c.Preview.PollInterval <= 0 || strings.TrimSpace(c.Preview.ModelLabel) == "" {
			return bad("preview 的页面目录、问题包、会话时长、轮询间隔和模型标识必填")
		}
	}
	if c.Portal.Enabled {
		if strings.HasPrefix(strings.ToLower(c.Auth.Token), "replace-") {
			return bad("portal requires a private backend token, not the example placeholder")
		}
		u, err := url.Parse(c.Portal.Origin)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Scheme != "https" && u.Scheme != "http" {
			return bad("portal.origin must be an explicit HTTP(S) origin")
		}
		if u.Scheme == "http" && u.Hostname() != "localhost" && (net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback()) {
			return bad("portal requires HTTPS outside loopback")
		}
		if c.Mode == "worker" || c.Preview.Enabled || c.Portal.PacksDir == "" || c.Portal.SessionTTL <= 0 || c.Portal.LoginLimit < 1 || c.Portal.LoginWindow <= 0 || c.Portal.MaxPackBytes <= 0 || c.Portal.MaxPackBytes > c.Server.MaxBodyBytes {
			return bad("portal requires api/both mode, a separate package directory and valid session/body limits; preview cannot share its routes")
		}
		p := c.Portal
		if p.ParticipantsEnabled && (p.AssetsDir == "" || p.PollInterval <= 0 || p.ModelLabel == "" || (p.EntryMode != "link" && p.EntryMode != "list") || (p.InvitationMode != "code" && p.InvitationMode != "none") || (p.ParticipantReports != "allow" && p.ParticipantReports != "deny")) {
			return bad("participant routes require explicit entry_mode, invitation_mode, participant_reports, assets and polling settings")
		}
	}
	if c.Server.ReadTimeout <= 0 || c.Server.WriteTimeout <= 0 || c.Server.ShutdownTimeout <= 0 || c.Server.MaxBodyBytes <= 0 {
		return bad("server 的超时和字节上限必须为正数")
	}
	if c.Database.MaxOpenConns < 4 || c.Database.MaxIdleConns < 0 || c.Database.MaxIdleConns > c.Database.MaxOpenConns || c.Database.ConnMaxLifetime <= 0 || c.Database.ConnectTimeout <= 0 {
		return bad("database 连接池或超时无效")
	}
	if strings.TrimSpace(c.Database.DSN) == "" {
		return bad("database.dsn 必填")
	}
	if len(c.Auth.Token) < 32 {
		return bad("auth 令牌至少 32 字符")
	}
	q := c.Queue
	if q.FollowupConcurrency < 1 || q.ReportConcurrency < 1 || q.PollInterval <= 0 || q.TaskTimeout <= 0 || q.HeartbeatInterval <= 0 || q.LeaseDuration < 3*q.HeartbeatInterval || q.MaxAttempts < 1 || q.MaxAttempts > 10 || q.RetryDelay <= 0 || q.MaxRetryDelay < q.RetryDelay || q.MaxInputBytes <= 0 || q.MaxOutputBytes <= 0 {
		return bad("queue 参数无效，租约须至少为心跳间隔的三倍，尝试次数为 1..10")
	}
	if len(c.Prompts) != 2 {
		return bad("prompts 只允许 followup 和 report")
	}
	for _, kind := range []string{"followup", "report"} {
		p, ok := c.Prompts[kind]
		if !ok {
			return bad("缺少 prompts." + kind)
		}
		if strings.TrimSpace(p.Version) == "" || len(p.Version) > 100 || strings.TrimSpace(p.Analyze) == "" || strings.TrimSpace(p.Compose) == "" || p.MaxFollowups < 0 || p.MaxFollowups > 10 {
			return bad("prompts." + kind + " 的版本、正文或轮次无效")
		}
		if kind == "report" && p.MaxFollowups != 0 {
			return bad("report.max_followups 必须为 0")
		}
		if p.MaxCorrections < 0 || p.MaxCorrections > 3 || kind != "report" && p.MaxCorrections != 0 {
			return bad("max_corrections 仅用于 report，范围为 0..3")
		}
		m := p.Model
		if m.Thinking != "" && m.Thinking != "enabled" && m.Thinking != "disabled" {
			return bad("model.thinking 必须为空、enabled 或 disabled")
		}
		if m.Name == "" || m.MaxTokens < 1 || m.Temperature == nil || *m.Temperature < 0 || *m.Temperature > 2 || m.ResponseFormat != "json_object" && m.ResponseFormat != "none" {
			return bad("prompts." + kind + ".model 参数不完整")
		}
		provider, ok := c.Providers[m.Provider]
		if !ok {
			return bad("未知 provider: " + m.Provider)
		}
		u, err := url.Parse(provider.BaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && u.Scheme != "http" || provider.RequestTimeout <= 0 {
			return bad("provider URL 或超时无效")
		}
		if c.Mode != "api" {
			if strings.TrimSpace(provider.APIKey) == "" {
				return bad("providers." + m.Provider + ".api_key 必填")
			}
		}
	}
	return nil
}

func (c Config) Release(kind string) Release {
	p := c.Prompts[kind]
	r := Release{Kind: kind, Pipeline: p, Provider: c.Providers[p.Model.Provider]}
	// 凭据只属于运行配置。版本快照不含密钥，轮换密钥不会改变提示词版本。
	r.Provider.APIKey = ""
	r.Hash = Hash(r)
	return r
}

func Hash(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	} // 调用方仅传入本包和领域模型中可序列化的类型。
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (r Release) ValidHash() bool { hash := r.Hash; r.Hash = ""; return hash == Hash(r) }
