
CREATE TABLE IF NOT EXISTS properties (
  property_id     BIGINT PRIMARY KEY,
  total_fractions BIGINT NOT NULL CHECK (total_fractions > 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS investors (
  wallet     TEXT PRIMARY KEY,
  kyc        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS token_holdings (
  property_id BIGINT NOT NULL,
  wallet      TEXT   NOT NULL,
  balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, wallet)
);
CREATE TABLE IF NOT EXISTS blockchain_events (
  id              BIGSERIAL PRIMARY KEY,
  chain_id        BIGINT NOT NULL,
  contract        TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  block_number    BIGINT NOT NULL,
  block_hash      TEXT,
  tx_index        INT,
  log_index       INT NOT NULL,
  event_sig       TEXT NOT NULL,
  property_id     BIGINT,
  token_id        BIGINT,
  sender          TEXT,
  receiver        TEXT,
  amount          BIGINT,
  confirmation_state TEXT NOT NULL DEFAULT 'confirmed',
  processing_state   TEXT NOT NULL DEFAULT 'new',
  retries         INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_event UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ix_events_new ON blockchain_events (processing_state, block_number, log_index);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  checked INT NOT NULL DEFAULT 0,
  mismatches INT NOT NULL DEFAULT 0,
  repaired INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
