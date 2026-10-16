CREATE TABLE IF NOT EXISTS tw_publisher_keys (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  prefix VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  last_used_at DATETIME(6) NULL,
  expires_at DATETIME(6) NULL
) ENGINE=InnoDB;
