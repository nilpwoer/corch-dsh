package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"encoding/json"
	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Account struct {
	Username     string `json:"username" gorm:"primaryKey"`
	PasswordHash string `json:"-"`
}

func (Account) TableName() string { return "tw_accounts" }

type AdminSession struct {
	TokenHash string
	Username  string
	ExpiresAt time.Time
}

func (AdminSession) TableName() string { return "tw_admin_sessions" }

// InitializeAdmin is insert-only; restarts never overwrite an existing database password.
func (s *Store) InitializeAdmin(ctx context.Context) error {
	var count int64
	if err := s.DB.WithContext(ctx).Model(&Account{}).Where("username=?", "admin").Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hash := s.Config.Portal.AdminPasswordHash
	if !accounts.ValidHash(hash) {
		return domain.Fail("ADMIN_BOOTSTRAP_HASH_REQUIRED", 503)
	}
	return s.DB.WithContext(ctx).Exec("INSERT INTO tw_accounts(username,password_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE username=username", "admin", hash).Error
}
func (s *Store) AuthenticateAccount(ctx context.Context, username, password string) error {
	var account Account
	err := s.DB.WithContext(ctx).Where("username=?", username).Take(&account).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return domain.Fail("INVALID_LOGIN", 401)
		}
		return err
	}
	if !accounts.Verify(account.PasswordHash, password) {
		return domain.Fail("INVALID_LOGIN", 401)
	}
	return nil
}
func sessionHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Store) NewAdminSession(ctx context.Context, username string) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw[:])
	err := s.DB.WithContext(ctx).Exec("INSERT INTO tw_admin_sessions(token_hash,username,expires_at) VALUES (?,?,UTC_TIMESTAMP(6)+INTERVAL ? MICROSECOND)", sessionHash(token), username, s.Config.Portal.SessionTTL.Microseconds()).Error
	return token, err
}
func (s *Store) AdminIdentity(ctx context.Context, token string) (string, error) {
	if len(token) != 64 {
		return "", domain.Fail("ADMIN_SESSION_REQUIRED", 401)
	}
	var session AdminSession
	err := s.DB.WithContext(ctx).Table("tw_admin_sessions AS s").Select("s.username").Joins("JOIN tw_accounts AS a ON a.username=s.username").Where("s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(6)", sessionHash(token)).Take(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", domain.Fail("ADMIN_SESSION_REQUIRED", 401)
	}
	return session.Username, err
}
func (s *Store) LogoutAdmin(ctx context.Context, token string) error {
	return s.DB.WithContext(ctx).Where("token_hash=?", sessionHash(token)).Delete(&AdminSession{}).Error
}
func (s *Store) Reports(ctx context.Context) ([]Task, error) {
	var reports []Task
	err := s.DB.WithContext(ctx).Where("kind='report'").Order("created_at DESC,id").Limit(200).Find(&reports).Error
	return reports, err
}

type ParticipantSession struct {
	TokenHash   string          `json:"-"`
	InterviewID string          `json:"interview_id"`
	PackKey     string          `json:"pack_key"`
	PackHash    string          `json:"pack_hash"`
	PackData    json.RawMessage `json:"-"`
	ExpiresAt   time.Time       `json:"-"`
}

func (ParticipantSession) TableName() string { return "tw_participant_sessions" }

// NewParticipantSession pins a publication copy and never stores an invitation code in the session.
func (s *Store) NewParticipantSession(ctx context.Context, entry published.Entry) (string, ParticipantSession, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", ParticipantSession{}, err
	}
	token := hex.EncodeToString(raw[:])
	copy := entry.Pack
	copy.Invitation = nil
	data, err := json.Marshal(copy)
	if err != nil {
		return "", ParticipantSession{}, err
	}
	row := ParticipantSession{TokenHash: sessionHash(token), InterviewID: uuid.NewString(), PackKey: entry.Key, PackHash: entry.Hash, PackData: data}
	err = s.DB.WithContext(ctx).Exec("INSERT INTO tw_participant_sessions(token_hash,interview_id,pack_key,pack_hash,pack_data,expires_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(6)+INTERVAL ? MICROSECOND)", row.TokenHash, row.InterviewID, row.PackKey, row.PackHash, row.PackData, s.Config.Portal.SessionTTL.Microseconds()).Error
	return token, row, err
}
func (s *Store) ParticipantIdentity(ctx context.Context, token string) (ParticipantSession, error) {
	var row ParticipantSession
	if len(token) != 64 {
		return row, domain.Fail("INTERVIEW_SESSION_REQUIRED", 401)
	}
	err := s.DB.WithContext(ctx).Where("token_hash=? AND expires_at>UTC_TIMESTAMP(6)", sessionHash(token)).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return row, domain.Fail("INTERVIEW_SESSION_REQUIRED", 401)
	}
	return row, err
}
func (s *Store) LogoutParticipant(ctx context.Context, token string) error {
	return s.DB.WithContext(ctx).Where("token_hash=?", sessionHash(token)).Delete(&ParticipantSession{}).Error
}
