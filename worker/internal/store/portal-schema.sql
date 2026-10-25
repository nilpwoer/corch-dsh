CREATE TABLE IF NOT EXISTS tw_accounts (
  username VARCHAR(100) COLLATE utf8mb4_bin PRIMARY KEY, password_hash VARCHAR(255) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_admin_sessions (
  token_hash CHAR(64) COLLATE utf8mb4_bin PRIMARY KEY, username VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL, INDEX tw_admin_expiry(expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_participant_sessions (
  token_hash CHAR(64) COLLATE utf8mb4_bin PRIMARY KEY, interview_id CHAR(36) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  pack_key VARCHAR(100) COLLATE utf8mb4_bin NOT NULL, pack_hash CHAR(64) NOT NULL, pack_data JSON NOT NULL,
  expires_at DATETIME(6) NOT NULL, INDEX tw_participant_expiry(expires_at)
) ENGINE=InnoDB;
