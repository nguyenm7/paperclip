CREATE TABLE IF NOT EXISTS feedback_issuer_nonces (
  issuer_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (issuer_id, nonce)
);

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

CREATE TABLE IF NOT EXISTS feedback_submissions (
  submission_id uuid PRIMARY KEY,
  grant_jti uuid NOT NULL UNIQUE REFERENCES feedback_grants(jti),
  installation_ref text NOT NULL,
  submission_mode text NOT NULL CHECK (submission_mode IN ('local_validation', 'production_feedback')),
  validation_run_id text,
  feedback_body text NOT NULL,
  route_template text NOT NULL,
  app_version text,
  deployment_mode text NOT NULL,
  browser text NOT NULL,
  operating_system text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_timestamp timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_queue_jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_queue_jobs_claim_idx
  ON feedback_queue_jobs (status, available_at, id);

CREATE TABLE IF NOT EXISTS feedback_asana_links (
  submission_id uuid PRIMARY KEY REFERENCES feedback_submissions(submission_id),
  task_gid text NOT NULL UNIQUE,
  parent_submission_id uuid REFERENCES feedback_submissions(submission_id),
  last_applied_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_asana_webhooks (
  webhook_gid text PRIMARY KEY,
  resource_gid text NOT NULL,
  secret_ciphertext text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_asana_deliveries (
  delivery_hash text PRIMARY KEY,
  webhook_gid text NOT NULL REFERENCES feedback_asana_webhooks(webhook_gid),
  event_count integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_transition_ledger (
  id bigserial PRIMARY KEY,
  task_gid text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
