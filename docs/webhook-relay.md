# Verified webhook relay

MeetStream signs the raw bytes of workspace-webhook requests. Make documents parsed `body`, headers, method, and query variables, but does not document a raw-body variable on which this signature can safely be checked. Re-serializing parsed JSON changes its bytes. The included relay verifies the original signature before making a new, verifiable envelope for Make. No unsigned callback is treated as authenticated.

## Setup

1. Install the private app, add **Watch Meeting Events** to a scenario, and create its dedicated webhook. Copy the Make-generated URL. Keep scenario filters disabled while testing.
2. Generate a random relay key of at least 32 characters in your secret manager. Enter it as **Relay Signing Key** in the Make webhook configuration. This key is distinct from your MeetStream API key and the workspace webhook secret.
3. Deploy the relay behind an HTTPS reverse proxy. Register its `/events` HTTPS URL at [MeetStream Webhooks](https://app.meetstream.ai/webhooks). Save the workspace signing secret shown on creation.
4. Supply the following environment variables through your hosting platform's secrets configuration. Do not store them in a blueprint, commit, command argument, or screenshot.

| Variable | Value |
|---|---|
| `MEETSTREAM_WEBHOOK_SECRET` | MeetStream workspace endpoint signing secret |
| `MAKE_RELAY_SECRET` | Same random signing key entered in the Make webhook |
| `MAKE_WEBHOOK_URL` | Generated URL on `hook.eu1/eu2/us1/us2.make.com` |
| `RELAY_DB` | Persistent writable SQLite path; default `.local/relay/events.sqlite` |
| `RELAY_HOST` | Default `127.0.0.1`; use `0.0.0.0` inside a container |
| `RELAY_PORT` | Default 3333 |

5. Run `npm run relay`, or deploy the supplied Dockerfile/Compose configuration after provisioning the secrets. Persist the database volume; an ephemeral container filesystem loses queued events and deduplication history.
6. Subscribe in MeetStream to `transcription.processed`, `video.processed`, `bot.done`, and all ending events: `bot.stopped`, `bot.kicked`, `bot.denied`, `bot.notallowed`, `bot.failed`. Subscribe to additional lifecycle events you need. Live transcript chunks use a separate webhook and are outside this relay's intended traffic volume.
7. Send a signed synthetic event, verify the 202 acknowledgement, trigger a dashboard **RESEND**, and confirm there is no second queued delivery. Then test a Make outage and recovery. Keep the corresponding execution references for review.

There is no automatic attach/delete API in the documented MeetStream contract. Register the relay endpoint once, and edit that existing endpoint when changing the URL. Do not create another on every scenario edit. On uninstall, disable/delete the MeetStream dashboard endpoint, stop the relay, and delete the Make webhook after its scenario is disabled.

## Verification and queue behavior

Only POST JSON at `/events` is accepted. Compressed input is rejected and the default maximum body is 256 KiB. The relay compares the `sha256=` HMAC over exact bytes using a constant-time comparison and requires a parseable delivery timestamp within five minutes. It checks bot ID and event-name shape before queuing. Unknown event names are permitted so a new service event does not break receipt.

The timestamp header is unsigned. The relay requires a timestamp string inside the signed JSON body and checks that it resolves to the same instant as the fresh delivery header. Deliveries missing a valid signed timestamp are rejected. MeetStream's published [signed delivery example](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification) shows both timestamps. For older deliveries, use the relay queue when an event is still present there. Confirm how your workspace dashboard resends events before relying on resend for recovery.

Accepted payloads are committed synchronously to SQLite before returning 202. The queue uses WAL and full synchronous durability. Payloads of successfully forwarded events are cleared; delivery hashes are retained for 90 days. The host still holds transcripts/metadata for pending and dead events: use encrypted storage, restrictive permissions, backups, and an explicit retention policy. Failed events are not silently pruned.

One-shot lifecycle keys use bot ID and `bot_event` (falling back to `event`). Artifact keys additionally include the relevant video/audio/transcript status, so a failed attempt cannot suppress a later success. Transcription keys use a transcript ID when supplied; without one, they hash the complete canonical payload so a distinct timestamp or changed job metadata is not suppressed forever. Informational/repeating events also use the full-payload hash. Identical payloads with neither a job ID nor distinguishing timestamp/metadata remain indistinguishable; the CRM scenario queries the latest successful job rather than trusting the bot's original transcript ID. Numeric bot IDs normalize to text, matching the reference. Events can be replayed after the hash-retention period; destination idempotency still matters.

**Upgrade note (October 30):** artifact delivery hashes now include processing outcome. Existing stored hashes are retained, but an old artifact may be forwarded once again under its new hash; destination deduplication remains necessary.

The relay forwards an envelope containing delivery ID, issue time, unmodified payload text, and an HMAC binding all three. The Make webhook recomputes that HMAC using its stored key, checks a five-minute issue-time window, and only then parses/maps the event. The relay renews the envelope timestamp on every retry, so outage recovery does not fail because the original timestamp became old.

Forwarding requires the exact app acknowledgement: HTTP 202 with `{"received":true}`. The relay accepts acknowledgements up to 4 KiB. Unexpected or oversized acknowledgements are retried. Network failures, 429, 5xx, and unexpected 2xx responses are retried with exponential backoff and jitter. Retry-After seconds and HTTP dates take precedence when they specify a longer wait. After eight attempts the event is dead and remains available for recovery. Permanent 4xx errors are dead immediately. Redirects are not followed and the target host is restricted to Make webhook zones.

This is at-least-once forwarding. If a process fails after Make accepted an event but before the queue recorded success, that event can be forwarded again. Use sequential scenarios and stable keys at CRM/storage destinations. A 202 acknowledges webhook receipt. Confidential drafts disable incomplete-execution storage. After a downstream failure, inspect the failed run and replay the full workflow with the original identifiers. The relay deduplicates a sent event and clears its payload, so resending it to the same relay cannot recover that Make run. Use the original event from an authorized source with a controlled replay scenario. MeetStream's one-attempt delivery policy means a relay outage **before queuing** still requires a resend from its Logs tab.

## Operate and recover

```sh
node relay/manage.mjs stats
node relay/manage.mjs requeue DELIVERY_ID
```

Use the database path configured for the running relay. The tool requeues only dead events after you have fixed the cause. Log entries expose action, delivery hash, HTTP status, and aggregate counts; they do not print payloads, URLs, or signing keys. Monitor `queue-health` for `dead`, sustained backlog, and disk exhaustion. `/health` checks liveness only; it does not certify that Make or the database is healthy. Restrict operational logs and database access.

Rotate the workspace secret in MeetStream and update the relay; rotate the relay key in both the relay and Make webhook. Plan the change to avoid a verification gap. Existing queued events can be resigned with the new relay key on delivery. Sync host clocks.

Use a reverse proxy for TLS, body limits, connection limits, and request-rate limits. `relay/nginx.conf.example` is a starting point for lifecycle traffic; tune it to observed volume. Deploy one service against a persistent database or use the queue's lease mechanism for worker coordination. A stalled lease becomes eligible after 60 seconds. Do not copy a live SQLite database by copying only its main file while WAL writes are active; use a SQLite-aware backup procedure.
