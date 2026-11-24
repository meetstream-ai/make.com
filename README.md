# MeetStream for Make

Native Make Custom App source for meeting bots, transcripts, summaries, recordings, and verified meeting events. Development version **0.1.3**, Make app version **1**.

The API reference is pinned to the official [n8n reference repository](https://github.com/meetstream-ai/n8n-plugin/tree/5319cd482c3cb17b836c0dd72d307117b1919729). See `reference/n8n-contract.json`.

This development version supports private Make installation. The optional Make AI workflow generates and stores a summary from a completed transcript. The native Get a Summary action requires an available MeetStream summary endpoint.

Start with the [Make quickstart](quickstart.md). See the [architecture and release workflow](docs/architecture.md) for how the native app, scenario blueprints, and relay fit together.

## Start locally

Use Node.js 22.13 or newer. The relay uses Node's built-in SQLite database; it has no runtime package dependencies. Ajv is used only to validate official Make schemas during development.

```sh
npm ci
npm run verify
npm run deploy:plan
```

The build creates individual native JSON components in `app/modules/` and `app/webhooks/`, three launch blueprint drafts, a calendar cleanup companion, and two on-demand summary workflows in `templates/`, and a combined upload bundle in `dist/meetstream.app.json`. That bundle is an input to the included uploader, not a Make scenario blueprint or a claimed SDK workspace export.

Edit module/webhook definitions in `scripts/build.mjs`, scenario definitions in `scripts/build-templates.mjs`, and the hand-authored foundation files in `app/`. Regenerate with `npm run build`. Do not edit generated JSON and then rebuild: the generator replaces it.

## Included modules

| Module | Behavior |
|---|---|
| Create a Bot | Immediate or scheduled bot; video, transcription, metadata, and stable deduplication |
| Get a Bot | Current status, transcript ID, and full bot details |
| List Transcriptions | One bundle per transcription job, with a configurable output limit |
| Get the Latest Successful Transcription | Select the latest completed job across all returned jobs, independently of the list module's output limit |
| Get a Transcript | Text, segments/participant groups, or raw provider JSON |
| Get a Summary | Upstream summary API; currently unavailable in live validation. Use the separate Make-generated summary workflows |
| Get a Recording | Metadata and a fresh one-hour video URL |
| Leave a Meeting | Stop an active bot or cancel a scheduled bot; retain data |
| Make an API Call | Required universal module; fixed MeetStream host and blocked redirects |
| Watch Meeting Events | Dedicated webhook accepting signed envelopes from the verification relay |

The native create module deliberately uses `deduplication_key` instead of `Idempotency-Key`: MeetStream returns HTTP 200 for the former's replay, while the latter returns HTTP 507, which Make treats as an error. Parallel first requests can still produce duplicate bots. Serialize creates and retries.

## Deployment and operation

- [Development installation and live checks](docs/development.md)
- [Connection setup, all modules, events, and troubleshooting](docs/user-guide.md)
- [Relay deployment, retries, recovery, and cleanup](docs/webhook-relay.md)
- [Blueprint setup and safe test paths](templates/README.md)
- [Generate and retrieve summaries inside Make](docs/make-generated-summaries.md)
- [API contract](docs/api-contract.md)
- [Release checklist](docs/release.md)

Support address reused from the n8n integration: **support@meetstream.ai**. A named support and release owner still needs to be assigned before launch.
