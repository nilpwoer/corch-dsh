CREATE TABLE IF NOT EXISTS tw_pack_access (
  pack_key VARCHAR(100) COLLATE utf8mb4_bin PRIMARY KEY,
  publication_hash CHAR(64) NOT NULL,
  revision BIGINT NOT NULL,
  code VARBINARY(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  source VARCHAR(16) NOT NULL
) ENGINE=InnoDB;
