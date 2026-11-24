# Develop and install the Custom App

## Upload a private development app

The source uses Make's documented app components and SDK REST endpoints. You can paste individual components into the web Apps Editor, or use the uploader. VS Code users can create the app with the official Make Apps Editor extension, then clone that remote app into a separate local SDK workspace. This repository does not invent a `makecomapp.json` export format.

1. In your development Make organization, create a token with `sdk-apps:read` and `sdk-apps:write`. Choose the zone containing that organization, such as `eu1.make.com`.
2. Load `MAKE_API_TOKEN` into your terminal environment using your local secrets manager. Set `MAKE_ZONE` and a unique `MAKE_APP_ID`, for example `meetstream-development`. Never put a token in command-line arguments or commit it.
3. Run `npm ci`, `npm run verify`, then `npm run deploy:plan` to inspect the upload target.
4. Run `npm run deploy`. The uploader creates a **private** app, creates/reuses the tracked connection and webhook identities returned by Make, then uploads the source components and user guide. It never changes app visibility or submits a review.
5. Open the app in Make's Apps Editor. Verify the connection, each component, the nested transcription fields, all date formats, and the signed webhook condition. The public SDK documentation's webhook-update schema is incomplete; if your zone rejects that upload, paste the webhook API/parameters in the Apps Editor and reconcile the identity in `.local/deployments/ZONE/APP_ID/state.json`. Resolve any rejected component before continuing.
6. Clone into VS Code using **Make Apps Editor → Clone to Local Folder** if desired. Keep origin token files outside version control. Make's generated app ID is immutable.
7. In the Modules list, change every intended module from **hidden** to **visible**. New modules start hidden even in a private app. Add a module to a scenario and save it; confirm private installation in your organization. Publishing is a separate irreversible visibility change and is not needed for testing.
8. Create a MeetStream connection in the scenario designer and enter a test key from `app.meetstream.ai/api-key` there. Run a read against a synthetic completed bot first.
9. Use the actual immutable Apps Editor ID to bind blueprint namespaces: `npm run templates:bind -- APP_ID`. Custom modules require `app#APP_ID:module`. Generate the CRM JSON structure from `templates/hubspot-properties.sample.json` and calendar state fields from `templates/calendar-state.sample.json`. Optionally pass the numeric IDs: `npm run templates:bind -- APP_ID CRM_JSON_STRUCTURE_ID CALENDAR_DATA_STORE_ID SUMMARY_DATA_STORE_ID`. The summary store is a separate optional fourth argument; its fields come from `templates/summary-state.schema.json`. See the [Make summary workflow setup](make-generated-summaries.md) before selecting a store or AI connection. Existing explicit store selections are preserved rather than overwritten by calendar binding.

The uploader isolates state by app and zone under `.local/deployments/ZONE/APP_ID/state.json`. It refuses unknown remote apps, public apps, mismatched state, and stale component identities. It writes state atomically, recovers a uniquely labeled connection/webhook from the remote catalog after ambiguous component creation, and stops if matching labels are ambiguous. A remote app creation without saved ownership still requires manual reconciliation. Keep the state files when retrying partial uploads. Account-specific identities never go into public blueprints.

## Live MeetStream checks

Configure these environment variables locally:

| Variable | Purpose |
|---|---|
| `MEETSTREAM_API_KEY` | Test workspace API key |
| `MEETSTREAM_TEST_BOT_ID` | Existing synthetic bot with completed processing |
| `MEETSTREAM_TEST_TRANSCRIPT_ID` | Optional completed transcript |

Run `npm run test:live`. It makes read requests using the same request/output definitions as the contract tests and writes only pass/fail, status, and timestamp evidence to `.local/live-evidence.json`. It also checks an invalid synthetic credential. It does not join or leave meetings. Missing variables produce exit code 2 and **no live-test success claim**.

This diagnostic deliberately includes the upstream Get a Summary API and will fail if that route returns 404. It does not generate or retrieve Make-stored summaries and is not the acceptance test for the Make AI workflow. Validate that alternative with both saved scenarios as described in the [summary setup guide](make-generated-summaries.md).

This command executes a small local expression harness against MeetStream. It does not run Make's actual IML engine. Run every module in real Make scenarios as a separate release gate. Use a meeting you control for Create/Leave tests, keep the returned bot ID, and always stop the test bot afterward. Manually verify malformed inputs, missing resources, 429/Retry-After handling, server errors, and a real signed dashboard resend on that development app.

## Automated checks

`npm run verify` rebuilds source and blueprint drafts, validates structural/security invariants, and runs tests against native expressions, published Make schemas, an HTTP fixture service, and a real SQLite-backed relay. It covers credential errors, Unicode and large transcripts, empty values, dates/offsets and DST boundaries, deduplication replay, webhook rejection, restart recovery, capacity, permanent errors, and bounded relay retries.

CI also rejects changes to committed generated files after rebuilding, or new generated files that were omitted from the commit. Keep `app/`, `dist/`, and generated blueprints in sync with their generators.

Schema snapshots come from Make's SDK API documentation. Passing them checks shape, not deployment compatibility. Third-party Make module versions and mapping interfaces in the blueprint drafts must be reconciled with the authenticated catalog before publication. After live verification, export the working scenarios from Make and replace the draft files with those verified exports, or update the generator to reproduce them.

## Native Make webhook checks

Configure a dedicated synthetic webhook on a saved scenario with **Watch Meeting Events**. Store its URL and signing key in a local ignored JSON file with keys `url` and `relaySecret`, restrict it to your user, then run `npm run test:make-webhook -- .secrets/make-webhook-test.json`. The script sends only generated synthetic data. It checks invalid/tampered signatures, stale/future envelopes, unsigned/GET requests, and a valid event. Evidence contains only statuses and pass/fail, without keys or webhook URLs. Reattach the webhook to a saved scenario before testing: an unassociated hook can return 410 for valid events. Process the accepted queue in Make and inspect its output; an HTTP acknowledgement alone does not prove a downstream execution succeeded.

`createJSON` and `parseJSON` are SDK functions available inside Custom App definitions. They are not scenario mapper functions. Use **JSON → Create JSON** / **Parse JSON** in scenarios. The CRM blueprint uses the native serializer to escape transcript text and format the UTC date.

Sources: [Make Apps Editor](https://developers.make.com/custom-apps-documentation/get-started/make-apps-editor/apps-sdk/creating-an-app-in-vs-code), [SDK app API](https://developers.make.com/api-documentation/api-reference/sdk-apps), [SDK module API](https://developers.make.com/api-documentation/api-reference/sdk-apps/modules).
