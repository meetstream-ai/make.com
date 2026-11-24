# API contract and test matrix

The API mappings and shared defaults are pinned to the [official n8n plugin](https://github.com/meetstream-ai/n8n-plugin/tree/5319cd482c3cb17b836c0dd72d307117b1919729) in `reference/n8n-contract.json`.

Reused references: `nodes/MeetStream/MeetStream.node.ts`, `credentials/MeetStreamApi.credentials.ts`, `test/execute-node.test.mjs`, `test/template-runtime.test.mjs`, `templates/02-transcript-to-crm.json`, and `docs/webhook-security.md`. `reference/n8n-contract.json` records provenance and all eight provider defaults; the generator consumes it. Regression tests compare native Make request bodies to those defaults, including language/override precedence, no-transcription defaults, and encoded IDs.

| Make module | Method and endpoint | Automated evidence |
|---|---|---|
| Connection | GET `/api/v1/bots` | Native schema, key validation, host restriction |
| Create a Bot | POST `/api/v1/bots/create_bot` | JSON payload, defaults, optional omissions, live required fields, input validation, HTTP 200 replay / 507 refusal |
| Get a Bot | GET `/api/v1/bots/{bot_id}/detail` | PascalCase API fields normalized, dates, absent values, fixture HTTP request |
| List Transcriptions | GET `/api/v1/bots/{bot_id}/transcriptions` | Limit, one bundle per job, date conversion |
| Get Latest Successful Transcription | GET `/api/v1/bots/{bot_id}/transcriptions` | Latest successful run selected independently of input array order, failed/processing runs skipped |
| Get a Transcript | GET `/api/v1/transcript/{transcript_id}/get_transcript` | Segment/participant variants, raw objects, Unicode, empty and large payloads |
| Get a Summary | GET `/api/v1/bots/{bot_id}/summary` | SDK-advertised route; generic live 404 and absent OpenAPI path require service confirmation. Rejects 202/empty success; real-summary 200 test blocked |
| Get a Recording | GET `/api/v1/bots/{bot_id}/get_video` | Metadata, missing URL/202 not-ready validation |
| Leave a Meeting | GET `/api/v1/bots/{bot_id}/remove_bot` | Matches n8n's method; 200/202 outputs and epoch dates; current API also supports POST |
| Universal | Caller-selected `/api/vN/...` on the fixed host | Host/credential override rejection, query/header mapping, cookie stripping, no redirects |
| Watch Meeting Events | Manual workspace endpoint → relay → Make | Raw HMAC verification, signed relay envelope, event alias handling, queue/replay/restart/retry tests |

All ordinary request contracts cover 400, 401, 403, 404, 409, 429, and 5xx using local fixtures; native execution on Make remains unverified. There is no documented numeric API rate limit to encode. The create endpoint also uses 429 when a requested signed-in login is unavailable, so 429 is not assumed to mean only request volume.

The bot-list OpenAPI response includes `hasNextPage`/`nextCursor` but does not document corresponding cursor inputs. That is insufficient evidence for a polling trigger. Transcription-job listing does not document pagination. Do not invent cursor parameters or poll full transcripts to detect changes.

Primary sources:

- [MeetStream OpenAPI](https://docs.meetstream.ai/openapi.json)
- [Deduplication and idempotency](https://docs.meetstream.ai/guides/features/deduplication-idempotency-keys)
- [Transcriptions](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-bot-transcriptions)
- [Post-call transcription and captions](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Official SDK coverage, including summary](https://docs.meetstream.ai/build-with-ai/sdks)
- [Sample apps, including summary endpoint](https://docs.meetstream.ai/tutorials/sample-apps)
- [Webhook signatures](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Workspace delivery and resend behavior](https://docs.meetstream.ai/guides/webhooks/workspace-webhooks)
- [Make review prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites)
- [Make HTTP errors cannot be converted to success](https://developers.make.com/custom-apps-documentation/best-practices/base/error-handling)

## Project-only summary workflow

The optional Make AI workflow generates a summary from a completed MeetStream transcript and retrieves it from Make Data Store. See the [setup guide](make-generated-summaries.md).
