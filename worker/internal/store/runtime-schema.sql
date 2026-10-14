CREATE TABLE IF NOT EXISTS tw_runtime_settings (
  scope_key VARCHAR(120) COLLATE utf8mb4_bin PRIMARY KEY,
  revision BIGINT NOT NULL, publication_hash CHAR(64) NOT NULL,
  contents JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_interview_runtime (
  interview_id VARCHAR(100) COLLATE utf8mb4_bin PRIMARY KEY,
  contents JSON NOT NULL
) ENGINE=InnoDB;
