CREATE TABLE IF NOT EXISTS feedback_issuer_nonces (
  issuer_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (issuer_id, nonce)
);

CREATE INDEX IF NOT EXISTS feedback_issuer_nonces_expiry_idx
  ON feedback_issuer_nonces (expires_at);

CREATE TABLE IF NOT EXISTS feedback_grants (
  jti uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  installation_ref text NOT NULL,
  submission_mode text NOT NULL CHECK (submission_mode IN ('local_validation', 'production_feedback')),
  validation_run_id text,
  follow_up_consent boolean NOT NULL,
  reporter_email_ciphertext text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  CHECK ((follow_up_consent AND reporter_email_ciphertext IS NOT NULL)
    OR (NOT follow_up_consent AND reporter_email_ciphertext IS NULL)),
  CHECK ((submission_mode = 'local_validation' AND validation_run_id IS NOT NULL)
    OR (submission_mode = 'production_feedback' AND validation_run_id IS NULL))
);

CREATE INDEX IF NOT EXISTS feedback_grants_retention_idx
  ON feedback_grants (redeemed_at, expires_at);

CREATE TABLE IF NOT EXISTS feedback_submissions (
  submission_id uuid PRIMARY KEY,
  grant_jti uuid NOT NULL UNIQUE REFERENCES feedback_grants(jti) ON DELETE CASCADE,
  installation_ref text NOT NULL,
  submission_mode text NOT NULL CHECK (submission_mode IN ('local_validation', 'production_feedback')),
  validation_run_id text,
  event_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((submission_mode = 'local_validation' AND validation_run_id IS NOT NULL)
    OR (submission_mode = 'production_feedback' AND validation_run_id IS NULL)),
  CHECK (event_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS feedback_submissions_received_idx
  ON feedback_submissions (received_at);
