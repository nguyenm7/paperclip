# Paperclip product feedback intake

This separately launched gateway is the isolated trust boundary between Paperclip's
in-product feedback dialog and the Paperclip-owned PostHog survey. It shares the
server package's dependency graph to preserve Paperclip's managed lockfile, but it
is not mounted in the main Paperclip application process and does not contain an
Asana or Slack credential. PostHog is the source of truth for feedback content.

## What the gateway does

The public HTTPS gateway exposes two endpoints:

- `POST /v1/grants` accepts a timestamped, nonce-protected HMAC request from a
  configured Paperclip installation. It returns a short-lived, one-use grant.
- `POST /v1/posthog/events` accepts a PostHog Event Destination delivery only
  after Standard Webhooks verification, survey/question/schema allowlisting,
  signed-grant validation, and atomic grant redemption.

The feedback text remains in PostHog. The intake database stores only replay
nonces, encrypted follow-up contact and consent, the grant envelope, and a
SHA-256 event receipt. It does not persist the feedback body, diagnostics,
browser, operating system, or route context.

## Security invariants

- Paperclip signs the exact three-field grant request body. Deployment mode and
  user identifiers never cross this boundary.
- Reporter email is encrypted with AES-256-GCM, bound to the submission ID as
  authenticated data, and never sent through PostHog or returned to the browser.
- The browser receives only a public `phc_` PostHog project token. Personal API
  keys and other privileged PostHog credentials are rejected by Paperclip.
- The client sends only the explicit `survey sent` event. Opening or dismissing
  the dialog sends nothing to PostHog.
- PostHog person profiles, autocapture, session replay, heatmaps, and popup
  surveys are not initialized. No PostHog JavaScript SDK is installed.
- Public request bodies are capped at 64 KiB. Deploy the gateway behind an edge
  rate limit and request-concurrency limit before enabling production traffic.
- Contact/grant data is retained for 90 days by default. Run
  `pnpm --filter @paperclipai/server feedback:retention:purge` daily;
  set `PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS` lower if policy requires it.
- Use a feedback-only database and a least-privilege database role. Never use
  the Paperclip application database or application owner role.
- Rotate the issuer, grant-signing, contact-encryption, and webhook secrets
  independently. Stop intake before rotating the contact-encryption key unless
  retained ciphertext has first been re-encrypted or intentionally purged.

`local_validation` additionally requires a configured run ID and future expiry.
Production must use `production_feedback`, which forbids validation fields.

## PostHog Event Destination

Use PostHog's HTTP Webhook destination and keep it disabled until the gateway
health check, migration, retention job, edge limits, and synthetic signature
test all pass.

- URL: `https://<gateway>/v1/posthog/events`
- Method: `POST`
- Signing: a dedicated Standard Webhooks secret stored only in PostHog and the
  gateway secret store
- Filter: `event == "survey sent"` and `$survey_id` equals the configured survey
  ID
- Body: map only the following reviewed properties; do not send the PostHog
  person object or arbitrary event properties

```json
{
  "event": "{event}",
  "distinct_id": "{distinct_id}",
  "survey_id": "{properties.$survey_id}",
  "question_id": "<configured-question-id>",
  "schema_version": "{properties.paperclip_schema_version}",
  "feedback": "{properties.$survey_response_<configured-question-id>}",
  "submission_id": "{properties.paperclip_submission_id}",
  "grant_token": "{properties.paperclip_submission_grant}",
  "submission_mode": "{properties.paperclip_submission_mode}",
  "validation_run_id": "{properties.paperclip_validation_run_id}",
  "installation_ref": "{properties.paperclip_installation_ref}",
  "client_timestamp": "{properties.paperclip_client_timestamp}",
  "route_template": "{properties.paperclip_route_template}",
  "app_version": "{properties.paperclip_app_version}",
  "deployment_mode": "{properties.paperclip_deployment_mode}",
  "browser": "{properties.paperclip_browser}",
  "operating_system": "{properties.paperclip_operating_system}",
  "diagnostics": "{properties.paperclip_diagnostics}"
}
```

The destination must be tested with a validation grant before switching the
gateway to `production_feedback`.

## Deployment

1. Provision a dedicated PostgreSQL database and secret values.
2. Apply `pnpm --filter @paperclipai/server feedback:migrate`.
3. Start `pnpm --filter @paperclipai/server feedback:gateway` (or the built
   `dist/product-feedback/gateway-entry.js`) as a separate process behind HTTPS
   and edge limits.
4. Schedule the retention purge daily and alert on failures.
5. Configure and test the single-survey PostHog Event Destination.
6. Bind each Paperclip environment with a unique issuer ID and secret, then set
   its Paperclip product-feedback environment variables.

Asana delivery, Slack discussion, automated triage, and agent execution are
deliberately deferred. They require typed decision state, non-forgeable webhook
registration, prompt-injection containment, and human approval gates. A later
PR may consume verified PostHog data, but it must not weaken this intake boundary.
