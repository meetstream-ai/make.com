# Launch scenario blueprint drafts

These native Make blueprint drafts include disabled execution gates. Bind the modules and validate each workflow with synthetic data before using it with production connections.

| File | Connections | Schedule |
|---|---|---|
| `01-calendar-auto-join.blueprint.json` | Google Calendar read access; MeetStream; dedicated calendar-state Data Store | 15 minutes by default; lead window must exceed interval |
| `01b-calendar-change-cleanup.blueprint.json` | Same Google Calendar account; MeetStream; same calendar-state Data Store | Watch updates including deletions; 15 minutes on Free |
| `02-transcript-to-hubspot.blueprint.json` | MeetStream; HubSpot CRM; verified event relay | Instant |
| `03-recording-to-drive.blueprint.json` | MeetStream; Google Drive; verified event relay | Instant |

Make's exported custom app identifiers require the `app#` prefix. Run `npm run templates:bind -- YOUR_APP_ID` using the immutable ID in the Apps Editor URL (for example, `meetstream-dev-example`). Import the generated files from `.local/templates/YOUR_APP_ID/`. A bare `meetstream:module` identifier produces **Module Not Found** in Make. Imported drafts have no connection or hook IDs. Bind every connection in the designer, create each instant webhook, and deploy/register its relay. Use a separate workspace endpoint/relay target for each destination webhook. The relay supports one target per deployment.

## Safe setup and test path

Calendar scanning has `enabled=false` in its first variable module. Event workflows and the cleanup companion have a first-route filter comparing literal `false` with `true`. Keep these gates as shipped. Import, bind test connections, inspect sample bundles, and evaluate the filters without performing writes. Synthetic contract tests run locally with `npm run verify` and never join a meeting or write a destination.

If separately choosing an end-to-end test later, deliberately enable the selected gate on a scenario using a test calendar/meeting you own, a synthetic completed bot, a test CRM contact, or a dedicated Drive folder. Configure scenario scheduling explicitly after import. Do not enable production schedules during review. A filter alone is not a replacement for choosing the correct test connections. Review execution data before taking screenshots; it can contain credentials in third-party logs or private customer information.

## Calendar → bot

The main blueprint scans `[MeetStream]`-tagged events in a rolling lead-time window. Set `calendarId` to the same calendar used by the cleanup companion and choose `leadMinutes` (default 20). The default covers Make's 15-minute schedule with overlap. Keep the lead window longer than the configured polling interval. Free accounts cannot use a five-minute schedule; choose a shorter verified interval only on a plan that supports it. It expands recurring occurrences using Google Calendar `singleEvents`, re-fetches each event before creating a bot, rejects cancelled/all-day/past events, and extracts permitted HTTPS links from conference entries, Location, or Description. The regex is stored as a plain setup variable so its quotes cannot break Make IML. Calendar identity is persisted in the Data Store; no duplicate JSON annotations are needed on the bot.

The stable key includes calendar, occurrence ID, previous bot ID, start time, and meeting URL. Repeated updates with the same saved schedule do not create another bot. If the start/link changes, the main scenario requests cancellation and checks `/stop_status` before creating the replacement. A pending or failed stop produces an explicit error rather than a second active bot. Including the previous bot ID avoids permanent key reuse when a schedule moves away and back. Each scenario is sequential. This does not serialize the calendar pair. The calendar draft explicitly enables video so it can feed the recording workflow. Disable Record Video in each calendar Create a Bot module if you only need audio or transcripts.

Create a Data Store dedicated to this scenario pair using the fields in `calendar-state.schema.json`: `bot_id`, `calendar_id`, `event_id`, `start_at`, `meeting_url`, and `status` (all text). Use **Generate** with `calendar-state.sample.json` to avoid accidentally inferring dates or URL field types. Bind **every** Data Store Check/Get/Add module in both blueprints to that same store. `datastore:ExistRecord` v1 outputs `exist` (UI label **Exists**). Get Record requires `returnWrapped=false` in its mapper; the fields then appear at the root, as the templates expect. The `data` mapper and these output paths passed a real synthetic save/check/read in Make. The main scenario is the mapping owner; its cleanup companion records completed cancellations. Keep other writers out of the calendar key namespace. A summary workflow on a shared Free-plan store can use its separate key prefix and optional fields.

After creating the CRM JSON structure and calendar store, optionally bind both IDs at once: `npm run templates:bind -- APP_ID CRM_JSON_STRUCTURE_ID CALENDAR_DATA_STORE_ID`. The resulting account-specific files stay in `.local/templates/APP_ID/`; public drafts retain no resource IDs.

The store key hashes calendar ID and occurrence ID. Bot IDs and revision state remain available even after an event loses its private properties. Calendar events are no longer patched and require no write permission. If a state save fails after creation, recover the bot ID from MeetStream using the same stable create key, then replay the occurrence and complete the state write. Do not replace the key on an uncertain create. The API call and state save are not one distributed transaction; operator recovery is still needed across that failure boundary.

The cleanup companion resolves updates by calendar/occurrence ID from the store and re-fetches the current event before deciding to stop its saved bot. This handles changed start/link values even when an event moves outside the main scan window, and prevents a stale cancellation notification from stopping an unchanged reactivated occurrence. After confirming stop completion, it retains `status=cancelled`; the main scan recreates a bot when the revised occurrence enters the lead window. Unmapped updates do nothing. A deleted event that Google no longer permits fetching stops with an error for operator reconciliation. Series-level deletions do not necessarily supply every stored occurrence ID: reconcile affected mappings after a whole-series deletion. The pair has no shared distributed lock; avoid overlapping executions and inspect failed state writes before replaying either scenario.

The scan requests at most 2,500 Google events. A `nextPageToken` raises a visible Throw Error before any partial page is processed. Narrow the window/query or implement verified pagination if that bound is exceeded. Missing/unsupported links on tagged timed events also raise an error. Link selection checks conference, location, and description candidates, including Zoom subdomains, and rejects spoofed hosts/userinfo. A rolling lead window avoids missing events created before the lead time. Missed scans/outages after the join time need operator reconciliation.

## Transcript → HubSpot

Use a signed `transcription.processed` event with `transcript_status=Success`. The scenario gets meeting context, selects the latest successful transcription run across the complete returned job array, fetches its final text, and PATCHes an **existing** contact identified by `custom_attributes.hubspot_contact_id`. Event metadata takes precedence, with bot metadata as a fallback; missing contact metadata raises an explicit error before any CRM request. It never creates a new contact or engagement on every resend.

The current native API module is `hubspotcrm:MakeAPICall` v2 (case-sensitive). Before enabling, configure module 22, **JSON → Create JSON**. Create its data structure using **Generate** and paste `hubspot-properties.sample.json`; retain the generated date type for `meetstream_meeting_started_at`. Map the four properties as shown in the draft. PATCH consumes `22.json`, not a hand-built JSON string. SDK `createJSON` is unavailable in scenario mappers. For this development account, the structure was generated and its quoted/Unicode text plus UTC date were verified in a real execution. Account IDs stay in `.local` only.

Create these HubSpot contact properties in your test account:

| Internal name | Suggested type |
|---|---|
| `meetstream_transcript_id` | Single-line text |
| `meetstream_bot_id` | Single-line text |
| `meetstream_meeting_started_at` | Single-line text containing UTC ISO date/time |
| `meetstream_transcript` | Multi-line text |

The scenario compares the stored transcript key to skip duplicate writes and compares epoch milliseconds with an inclusive numeric comparison to allow a new transcript for the same meeting while refusing older meetings. Fractional-second and offset formats are handled explicitly. JSON string encoding preserves quotes, backslashes, and Unicode. The contact must exist, the API scopes must allow its read/update, and timestamps must be normalized in the live module interface.

Text above 15,000 characters is shortened to a bounded excerpt, separated with real newlines via `decodeURL`, and clearly marked `[Transcript truncated…]`; the selected transcript ID remains stored so the complete transcript can be retrieved. Empty speech raises an error instead of overwriting a CRM property. This follows the reference's marked-truncation approach with a conservative Make/CRM property budget. It updates the latest transcript on one contact, not a permanent history of every meeting. Replay not-ready events from the start after the job is ready; do not blindly retry authentication failures.

## Recording → Google Drive

Configure `folderId` as the customer's writable test folder. Set `maxSizeMb` to a value within that customer's Make plan and storage constraints (draft default 5, matching Free). Confirm the downloaded media's actual filename/container; change the `.mp4` filename if your account returns another format.

Make Free currently permits two active scenarios, 15-minute scheduled intervals and files up to 5 MB. Test these drafts one at a time. Running all three launch workflows plus cleanup concurrently needs a suitable plan or a separately verified consolidation. Cancellation polling can be delayed by the chosen interval; use a test meeting and verify the timing before enabling. See [Make pricing](https://www.make.com/en/pricing) and [file limits](https://help.make.com/working-with-files).

The scenario escapes apostrophes and backslashes in Drive query literals as required by [Google’s query rules](https://developers.google.com/workspace/drive/api/guides/search-files), looks for `meetstream-BOT_ID.mp4` in that folder, skips existing files, obtains a fresh one-hour URL, immediately downloads it without MeetStream authorization headers, and uploads to Drive. Keep sequential execution enabled. The draft has no retry handler and incomplete-execution storage is disabled: after an ambiguous upload failure, replay the full event so the filename check runs first. If Make resumes only the failed upload, it can create a duplicate. If the download URL expired, rerun Get a Recording first.

Missing, zero, negative or nonnumeric size, oversized recordings, missing lookup results, and paginated Drive lookup results raise explicit errors. The error text explains the required metadata, folder inspection, or customer storage transfer; those events no longer disappear behind filters. Before enabling, configure the customer's plan limit, Drive permissions, and file visibility. Automated fixtures cover size guards and duplicate lookup branches; verify provider permissions and uploads in your workspace. Existing files with the deterministic name are treated as already archived; use a dedicated folder so unrelated files cannot masquerade as this archive.

## Optional Make-generated summaries

`04-transcript-to-stored-summary.blueprint.json` generates a summary from a real completed transcript and stores it. `04b-get-stored-summary.blueprint.json` retrieves that exact stored artifact without any AI call. Both start with `enabled=false`; select On demand scheduling. Configure the same summary Data Store in both, the MeetStream connection in the generator, and Make AI Provider for its AI module. The placeholder `SUMMARY_DATA_STORE_ID` is deliberately separate from calendar store binding. See the [full setup, source fields, storage and recovery limits](../docs/make-generated-summaries.md). No external Calendar, Drive or HubSpot connection is needed. These workflows do not repair or impersonate MeetStream's summary endpoint.

## Recovery, review, and cleanup

Drafts keep processed data confidential and disable incomplete-execution storage. Make hides incomplete-execution recovery in confidential mode and rejects Retry/Break directives that require it; these drafts therefore let errors stop visibly without such handlers. Inspect failed run status, fix the cause, and replay from the start using the same stable IDs. Replaying a CRM or recording run requires the original event from an authorized source because the relay suppresses repeats after delivery. Start recording recovery at filename lookup. Reuse the original create key for calendar recovery. Make can separately retry some transient action failures; verify the target account policy and Retry-After guidance before enabling a production schedule. Do not enable automatic completion of an uncertain upload. Never resume an ambiguous upload alone: replay from the filename check. Explicit Throw Error routes can pause/deactivate a scenario; the operator must inspect and recover those cases. Stop-status failures require re-reading status before replaying the affected occurrence, rather than resuming a captured Throw Error unchanged.

Disable schedules and endpoint registrations after testing. Stop any active/scheduled test bot with Leave a Meeting, remove test contacts/properties/files as appropriate, and remove temporary tunnels. Document each clean import, configured connections, tested output, and execution reference in the release checklist. Published gallery URLs remain pending until Make confirms the chosen publication route and approves them.

The 0.1.3 CRM draft requires the updated Get a Transcript module and its `text_incomplete` field. It fails before the HubSpot write if malformed word values make the formatted text incomplete. Re-import the updated draft after updating the private app; existing saved scenarios do not acquire this guard automatically.

The legacy HTTP download module explicitly sets `serializeUrl:false`: Make requires this mapper value, and serializing a pre-signed URL can alter its signature. The draft filename defaults to `.mp4`. Verify the container for your own recordings.
