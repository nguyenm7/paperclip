# Paperclip product feedback service

This private workspace package is the isolated trust boundary for in-product feedback. It is not mounted in the Paperclip application server.

The first local canary deliberately does not run this service or require its PostgreSQL database. The Paperclip UI captures a validation-only PostHog survey event, and the disabled-by-default destination in `posthog/asana-local-validation.hog` creates an Asana task directly. That canary accepts at-least-once delivery, does not collect reporter contact data, and filters on the exact survey ID, direct-delivery mode, validation submission mode, and validation run ID.

The brokered service below remains the production-hardening reference. It becomes necessary when real-user contact storage, atomic grant redemption, durable idempotency, a dead-letter queue, or Asana webhook reconciliation enters scope.

## Processes

- `gateway`: public HTTPS ingress for grant issuance, PostHog Event Destination delivery, and Asana webhooks. It cannot call Asana.
- `worker`: private queue consumer. It alone receives the restricted Asana service-account token.
- PostgreSQL: durable grants, replay nonces, normalized submissions, queue jobs, dead-letter state, webhook receipts, task links, and the transition ledger.

Run the gateway and worker as separate processes and preferably separate database roles. The gateway role needs insert/select/update access to intake and queue tables. The worker role needs queue, submission, task-link, webhook, and ledger access. Neither role should be the Paperclip application database owner.

## Security invariants

- Paperclip signs the exact grant request body with an issuer-scoped HMAC. Timestamp and nonce checks prevent replay.
- Reporter email is encrypted before storage and is never sent through PostHog or written into Asana.
- PostHog deliveries must pass Standard Webhooks verification, the exact survey/question/schema allowlist, signed-grant validation, and atomic one-use redemption before queuing.
- Asana handshakes persist the generated secret encrypted once. A later handshake cannot replace an active secret. Later webhook requests are verified over the raw body and deduplicated before queuing.
- User feedback is placed only inside a clearly delimited untrusted-data block. Workers never follow links or access customer environments.
- `local_validation` requires a configured run ID and expiry. Validation tasks go only to the validation section.
- Failed jobs retry with exponential backoff and become `dead` after eight attempts. Errors are stored as bounded codes, not raw vendor responses.

## PostHog Event Destination

Use the stable `HTTP Webhook` template. Keep it disabled until the gateway health check, database migration, and synthetic signature tests pass.

- URL: `https://<gateway>/v1/posthog/events`
- Method: `POST`
- Signing secret: a dedicated Standard Webhooks secret stored only in PostHog and the gateway secret store
- Filter: event equals `survey sent` and `$survey_id` equals the configured survey ID
- Body: the exact flattened schema accepted by `posthogFeedbackDeliverySchema`; do not send the person object or arbitrary event properties

The destination should be tested with a validation grant, then enabled only for the single feedback survey.

### Direct local-validation destination

The direct destination is project-specific and intentionally narrow:

- Survey: `01a05fce-0525-0000-5689-acf82c7699b2`
- Question: `6931933d-7f17-46a1-bb08-2e330cebd513`
- Validation run: `looa-2103-direct-asana-2026-09-01`
- Asana project: `1218079435761879`
- Asana section: `1218079745693014` (`Validation canary`)

Create it as a custom PostHog realtime destination with one required secret string input named `asanaToken`. Keep it disabled until the token belongs to a dedicated, least-privileged Asana integration identity and a synthetic invocation succeeds. Never substitute an operator's broad personal token merely to finish the canary.

This path intentionally has no intake database, grant redemption, Asana webhook, or automatic retry reconciliation. Use `Canonical submission ID` to identify duplicates during the validation window, and delete synthetic tasks after evidence is recorded.

## Asana

The source-of-truth project must provide separate `Validation canary` and `New` sections plus the granular review phases in the approved plan. Configure custom field and enum-option GIDs in `PRODUCT_FEEDBACK_ASANA_CUSTOM_FIELDS_JSON`; keys are field GIDs and values are enum option GIDs.

Create the Asana webhook only after the public target exists. The target is:

`https://<gateway>/v1/asana/webhooks/<PRODUCT_FEEDBACK_ASANA_WEBHOOK_REF>`

Treat `PRODUCT_FEEDBACK_ASANA_WEBHOOK_REF` as a high-entropy capability. Use a new reference when you replace a webhook. The receiver accepts only the first handshake for each reference, so an unauthenticated retry cannot replace the active signing secret.

The webhook receiver acknowledges in under ten seconds and queues reconciliation. A scheduled reconciler must also refetch project state to cover Asana's at-most-once exceptional loss cases. A retried task-creation job first scans the strongly consistent project task list for its canonical submission ID. It reuses the matching task before it sends another create request.

## Local durable proof

Use a feedback-only database, apply `pnpm --filter @paperclipai/product-feedback-service migrate`, and run the gateway and worker separately. Never place production vendor credentials in this worktree or the Paperclip application database.

### Manual Asana-to-Paperclip triage proof

Before enabling the Asana webhook, one normalized Asana task can be passed to a
local Paperclip triage agent with:

```sh
PRODUCT_FEEDBACK_PAPERCLIP_API_URL=http://127.0.0.1:3132 \
PRODUCT_FEEDBACK_PAPERCLIP_COMPANY_ID=<company-uuid> \
PRODUCT_FEEDBACK_PAPERCLIP_TRIAGE_AGENT_ID=<agent-uuid> \
PRODUCT_FEEDBACK_PAPERCLIP_PARENT_ISSUE_ID=<local-canary-parent-uuid> \
pnpm --filter @paperclipai/product-feedback-service triage:once -- ./normalized-feedback.json
```

Use `PRODUCT_FEEDBACK_PAPERCLIP_API_KEY` when the target requires authentication.
The production identity must be a dedicated `task_bridge` key bounded to the
feedback project or parent and allowlisted only for the triage agent. The command
accepts a strict, 64 KiB-bounded normalized JSON file; it rejects arbitrary Asana
fields and reporter contact data.

The created Paperclip task is an execution mirror. Asana remains the source of
truth for feedback status. Retries use one Paperclip idempotency key derived from
both the Asana task GID and canonical submission ID, while `allowDuplicate` avoids
collapsing two distinct submissions that happen to have the same generated title.
The triage description preserves the approved human gates for bugs, requests,
ideas, and needs-info cases. This manual path does not write status back to Asana
and does not enable the paused PostHog destination or Asana webhook.

## Slack human-decision gate

The General Feedback Reviewer must stop at a Slack discussion gate after it
classifies an intake and before it creates any reproduction, plan, prototype, or
implementation work. The local canary uses a dedicated
`#in-product-feedback` channel and the operating contract in
`agent/SLACK-HUMAN-GATE.md`. Workspace and channel IDs remain runtime
configuration and must not be hard-coded in the repository.

For the local canary, bind an existing Paperclip secret reference only to the
General Feedback Reviewer; never copy its value into the repository or task
data. The helper verifies the exact workspace and channel and invokes only the
Slack methods needed to authenticate, inspect/join the target, post the root,
and read its thread. A raw bot-token projection is not a production privilege
boundary, so production should put the credential behind a narrow broker or
tool connection that enforces the channel and method allowlist independently of
the agent.

For the local MVP, wake the reviewer manually after a teammate records a
structured `DECISION:` reply and checks **Also send to channel**. Slack bot
tokens cannot read ordinary public-channel thread replies, but the broadcast
reply is exposed as a `thread_broadcast` record in channel history. The reviewer
validates that explicit record with the allowlisted Slack user IDs and records immutable provenance on the
Paperclip issue, and only then advances the workflow. Informal discussion,
non-broadcast replies, unauthorized replies, conflicting decisions, and Slack
failures all leave the task stopped.

`src/slack-human-gate.ts` owns the bounded message format, strict decision
selection, explicit supersession, and `triage-learning/v1` example contract.
Learning examples are versioned retrieval context. They can support a proposed
policy diff, but Slack content never mutates the live agent instructions without
a human review of that exact revision.

The Content Oracle bot token can be reused through an existing Paperclip secret
reference. Bind it to the reviewer as `SLACK_BOT_TOKEN` with the
`slack.bot_token` class-3 projection allowlist. Do not retrieve or duplicate the
secret value. Set the non-secret team, channel, channel-name, and reviewer-ID
environment fields from `.env.example` on the agent runtime.

The reviewer can then use the narrow helper without handling a raw token:

```sh
pnpm --filter @paperclipai/product-feedback-service slack:gate -- setup
pnpm --filter @paperclipai/product-feedback-service slack:gate -- post ./triage-recommendation.json
pnpm --filter @paperclipai/product-feedback-service slack:gate -- notify ./review-notification.json
pnpm --filter @paperclipai/product-feedback-service slack:gate -- decision <thread-ts>
```

`setup` verifies the bot's workspace and the exact public channel before joining
it. `post` disables unfurls, supplies a deterministic Slack client message ID,
and returns only channel/thread provenance. `decision` reads at most 100 messages
from that thread and accepts only the configured human reviewer IDs. When the bot
token cannot retrieve ordinary channel replies, it considers only explicit
`thread_broadcast` records from bounded channel history; non-broadcast replies
remain advisory. Slack API errors are returned as bounded codes without vendor
response bodies.

`notify` posts an idempotent, non-broadcast reply into the original feedback
thread after the authoritative review path exists. Use `task_review` when a
versioned local prototype and its human-only Paperclip confirmation are ready.
Use `pull_request_review` when an actual `paperclipai/paperclip` PR and its
human-only review path are ready. The helper mentions only configured reviewer
IDs, disables unfurls, requires the issue origin configured in
`PRODUCT_FEEDBACK_PAPERCLIP_REVIEW_BASE_URL`, rejects off-origin task-review
links and non-Paperclip PR links, and returns bounded message provenance. A
Slack reply or reaction never resolves either review gate.
