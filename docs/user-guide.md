# MeetStream in Make

Private development source build **0.1.3**, updated November 24, 2026. Make app major version remains **1**.

MeetStream sends bots to Google Meet, Zoom, and Microsoft Teams meetings. A bot can record a meeting and produce transcripts that later modules use. The separate Make AI summary workflows generate and store summaries from real transcripts; upstream Get a Summary additionally requires service support and remains unavailable in live validation.

## Install and connect

This development app has no public listing yet. A developer must install the private app in your Make organization using the development guide supplied as `docs/development.md`. After Make approves a public listing, the listing/install link will be added here.

Create a **MeetStream API Key** connection. Get the key from [MeetStream API keys](https://app.meetstream.ai/api-key), copy only the key, and paste it into the connection's password field. The app adds `Authorization: Token …`. The connection checks the API by listing bots; an invalid key fails visibly. Module request logs sanitize authorization and request/response bodies. Scenario execution data can still contain transcripts and recording URLs, so use Make's confidential-data setting and your organization's retention controls.

## Module reference

### Create a Bot

Enter a supported HTTPS meeting URL, the bot name, and a **Deduplication Key**. The key is required: use one printable ASCII value, up to 2,000 characters, for a logical meeting. Reuse it for retries; generate a different key for a different meeting. Reusing a key against a different URL returns 409. Keys do not expire. Serialize first creates: MeetStream's lookup is not an atomic lock and can fail open.

Leave **Join At** blank to join immediately, or map a future date/time with a timezone. Make formats it as UTC. **Record Video** defaults to off for new bots. Enable it when you need a video recording. MeetStream usage/credits and meeting access policies apply.

Transcription defaults to **None**, matching the reference n8n integration. Enable a mode explicitly when you need transcripts. Supported modes:

- **Post-call** offers `meetstream`, `deepgram`, `assemblyai`, `jigsawstack`, `sarvam`, or `meeting_captions` in the Provider selector. The selected provider receives the defaults pinned from the n8n repository. Set Language to override its default language; Provider Options (JSON) override individual default fields. `postCall` is the canonical n8n-compatible mode value; the earlier `post` value remains accepted for old drafts.
- **Live** offers `deepgram_streaming` and `assemblyai_streaming`, defaults to Deepgram, and requires a live transcript webhook URL. Language and provider overrides work the same way. Streaming chunks and lifecycle events are different channels; streaming providers do not produce the usual post-call transcript-ready event.
- **None** omits transcription configuration.

Provider Options, Recording Configuration Override, and Custom Attributes must be JSON objects. A nonempty complete Recording Configuration Override takes precedence over the provider controls; `{}` uses the controls. This retains compatibility with the original draft's full JSON configuration. Metadata is echoed in events; never store credentials in it. Empty metadata is omitted from the request. A Lifecycle Callback URL is optional and **unsigned**. For verified production events, use a dashboard workspace webhook through the relay.

Outputs include bot ID, transcript ID when provided, status, meeting URL, join date, and whether the request replayed an existing bot. A successful create replay uses HTTP 200. The alternative `Idempotency-Key` mechanism uses HTTP 507 and is not supported as success in native Make modules.

### Get a Bot

Map the bot ID. Outputs expose normalized ID/status, meeting URL, platform, transcript ID, created/updated dates, and the complete API bot-details collection. Status labels are passed through from the API. Do not impose your own sequence on out-of-order events. The `details.caption_file` artifact is the route for `meeting_captions`; such bots deliberately have no post-call transcript ID.

### List Transcriptions

Map the bot ID and set a limit from 1 to 100; default 10. Each transcription job is a separate bundle containing its ID, provider, `Success`/`Processing`/`Failed` status, date, configuration, and artifact URLs. Filter for `Success` before fetching a transcript. The documented endpoint returns a job array without documented pagination inputs. The limit bounds downstream bundles, not server payload size, and does not imply sorting or latest-first selection.

### Get a Transcript

Use a transcript ID from Create a Bot, Get a Bot, or a successful transcription job. Outputs contain **Transcript Text**, the original segment/participant-group array, and the complete response as JSON. Empty transcripts produce empty text and an empty array. Text follows API response order; participant-grouped responses retain speaker metadata in the array and are not re-sorted into a conversational timeline. Raw Provider Response returns the provider JSON and deliberately leaves normalized text/segments empty.

Transcription IDs are not bot IDs. A 404 can mean unavailable or not found; a 409 can mean transcription was disabled or the bot never joined. Wait for `transcription.processed` before retrieval. The API's summary and transcript generation can finish at different times.

### Get the Latest Successful Transcription

Map a bot ID to select the newest `Success` job by `created_at`, matching the reference repository's CRM template. It returns the selected transcript ID and fails clearly when no completed job is available. Unlike taking the bot's original ID or the first limited job bundle, it handles retranscription runs. A separate streaming/captions channel still needs its corresponding artifact path. The selector follows the reference's ISO timestamp ordering; confirm provider date formats in the live test workspace.

### Get a Summary

Map the bot ID. **Summary** preserves the API response and **Summary JSON** retains its complete representation. Only HTTP 200 with a nonempty response can produce a success bundle; HTTP 202 and empty responses raise DataError rather than pretending a completed summary exists. Retry processing responses using a bounded policy. A completed transcript or `bot.done` does not prove that an AI summary was generated. There is no assumed `summary.ready` event.

If the endpoint returns 404, verify the bot and confirm summary support for your workspace. Use the separate Make AI workflow to generate and retrieve a summary from a completed transcript.

### Generate and retrieve a summary in Make

Use the two optional [Make-generated summary workflows](make-generated-summaries.md). The generator selects a real completed transcript, rejects empty/incomplete/oversized input, generates a summary with Make AI Toolkit, stores it by bot/transcript/policy, and reads it back. Repeat runs retrieve the existing record without an AI call. The independent retrieval companion takes the exact bot/transcript IDs and reads the same stored result without calling MeetStream or AI. Results explicitly report `summary_source=make_ai_toolkit`; review AI output before relying on it. Configure both imported scenarios to run on demand.

### Get a Recording

Map the bot ID after `video.processed`. The video URL is valid for **one hour**; download and forward it immediately to customer-owned storage. Outputs include size/duration/resolution metadata and fetch time. Missing URLs or a processing response produce a not-ready error. If a URL expires, rerun Get a Recording rather than repeatedly retrying the expired link. Ensure your Make plan and destination can handle the file size. Do not treat the URL as permanent storage.

### Leave a Meeting

Map the bot ID to stop the active bot or cancel a scheduled bot. Data is retained. A 202 response means the stop is still in progress; it does not prove the bot has left. Outputs include stop state, control request ID, dates, reason, and bot status. Confirm completion using Get a Bot, lifecycle events, or the stop-status endpoint through the universal module.

### Make an API Call

Enter a path relative to `https://api.meetstream.ai`, such as `/api/v1/bots`. Query parameters go in Query String. Choose the method and optional JSON body/headers. The host is fixed, redirects are disabled, and Authorization/Host/Cookie overrides are rejected. The connection supplies authentication. Arbitrary writes can join or stop meetings, incur charges, or delete data; you are responsible for the selected method, path, and body. Responses expose body, non-cookie headers, and status code. API errors remain errors.

### Watch Meeting Events

Create a **MeetStream Verified Meeting Events** webhook and follow the relay guide supplied as `docs/webhook-relay.md`. Registration is manual in MeetStream's dashboard because no documented endpoint-registration API is available. It is a dedicated, unattached webhook; it requires no MeetStream connection itself.

Use **Bot Event** to route events. The legacy `event` field always says `bot.stopped` for several terminal outcomes; `bot_event` distinguishes `bot.denied`, `bot.kicked`, `bot.notallowed`, `bot.failed`, and `bot.stopped`. Subscribe to all five terminal events plus `bot.done`, `transcription.processed`, and `video.processed`. Unknown events are exposed and should be ignored by scenarios that do not use them.

The relay verifies the workspace signature, queues accepted events durably, and retries forwarding to Make. It suppresses recognized duplicates; downstream writes must still be idempotent because a timeout after acceptance can cause another delivery. Make's acknowledgement means its webhook received the message, not that every downstream module succeeded. Monitor failed scenario runs separately; confidential launch drafts require full-event replay. Event order is not guaranteed. No bot-status polling trigger is included: the current list documentation does not establish a complete cursor/timestamp polling contract.

## Errors and retries

| Result | Action |
|---|---|
| 400 | Check meeting URL, recording JSON, and future Join At; fix before retrying |
| 401/403 | Check key, ownership, permissions, and credits; do not retry unchanged credentials |
| 404 | Verify the resource ID and endpoint support. For Summary, an existing bot does not prove the route or summary is available; do not blindly retry |
| 409 | Resolve deduplication conflict or disabled transcription |
| 429 | Read Retry-After; check throttling or signed-in bot availability |
| 5xx / timeout | Retry reads with a finite budget; preserve the key when retrying bot creation |
| 507 | Idempotency replay; do not automatically retry this status |

Make owns action-request retries. The app classifies 429 as `RateLimitError`, provides Retry-After in the message, and classifies ordinary server failures through Make's defaults. Make's native repeat directive only permits hard-coded delay/limit values; this app does not dynamically honor Retry-After inside an action. Configure a bounded policy that respects service guidance. Confidential launch drafts disable incomplete-execution storage and omit Retry/Break handlers that depend on it. Recover failed drafts by replaying the whole event. Make may apply its own transient-error policy; if you choose a different retention/recovery policy, verify its automatic retries separately. Verify that account-level policy, especially for uploads; after an uncertain upload replay the full event from its filename check. Module 403 errors use `DataError` because ownership/credit restrictions can occur with a valid connection; the connection's own credential test still rejects invalid keys. The relay independently implements backoff, jitter, Retry-After seconds/HTTP dates, and eight attempts.

See `templates/README.md` in the source bundle for connections, destination properties, safety gates, and known limits. For support, contact **support@meetstream.ai** with module name, status code, and redacted execution reference. Do not include keys, presigned URLs, or customer transcripts.

Version 0.1.3 formats mixed transcript shapes per segment and exposes `text_incomplete` when word-text values have unsupported types. Inspect `segments` and `raw_json` in that case; do not write the partial text to a destination. The CRM draft explicitly blocks it. Raw-provider mode preserves the response without formatting. Latest successful transcript selection normalizes ISO timestamp offsets to UTC; missing/non-ISO dates rank behind known dates.
