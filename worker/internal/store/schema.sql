CREATE TABLE IF NOT EXISTS tw_schema (version INT PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_releases (
  id VARCHAR(120) COLLATE utf8mb4_bin PRIMARY KEY, hash CHAR(64) NOT NULL, contents JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_interviews (
  id VARCHAR(100) COLLATE utf8mb4_bin PRIMARY KEY, input_version BIGINT NOT NULL,
  input_hash CHAR(64) NOT NULL, frozen BOOLEAN NOT NULL DEFAULT FALSE,
  report_version BIGINT NOT NULL DEFAULT 0, followup_release JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_snapshots (
  interview_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL, input_version BIGINT NOT NULL,
  contents JSON NOT NULL, PRIMARY KEY(interview_id,input_version)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_tasks (
  id CHAR(36) COLLATE utf8mb4_bin PRIMARY KEY, interview_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  kind VARCHAR(16) NOT NULL, followup_key CHAR(64) COLLATE utf8mb4_bin UNIQUE,
  input JSON NOT NULL, release_data JSON NOT NULL,
  report_version BIGINT NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL,
  attempt INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL, claim_token CHAR(36),
  lease_until DATETIME(6), available_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  options JSON NOT NULL, output JSON, error_code VARCHAR(100),
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX tw_claim(kind,status,available_at,created_at), INDEX tw_expiry(kind,status,lease_until),
  INDEX tw_interview(interview_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_requests (
  request_key VARCHAR(200) COLLATE utf8mb4_bin PRIMARY KEY, input_hash CHAR(64) NOT NULL,
  task_id CHAR(36) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_followups (
  task_id CHAR(36) COLLATE utf8mb4_bin PRIMARY KEY, interview_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  question_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL, input_version BIGINT NOT NULL, text TEXT NOT NULL,
  INDEX tw_followup_question(interview_id,question_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_stages (
  task_id CHAR(36) COLLATE utf8mb4_bin NOT NULL, stage VARCHAR(20) NOT NULL,
  output JSON NOT NULL, PRIMARY KEY(task_id,stage)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tw_calls (
  id CHAR(36) COLLATE utf8mb4_bin PRIMARY KEY, task_id CHAR(36) COLLATE utf8mb4_bin NOT NULL,
  stage VARCHAR(20) NOT NULL, request JSON NOT NULL, response MEDIUMTEXT,
  error_code VARCHAR(100), created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  INDEX tw_call_task(task_id,created_at)
) ENGINE=InnoDB;
