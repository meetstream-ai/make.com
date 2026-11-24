# Generate and retrieve summaries inside Make

This workflow uses **Make AI Toolkit**, not MeetStream's unavailable summary API. It reads a real, successful MeetStream transcript, creates an AI summary, saves it in a private Make Data Store, and retrieves the stored artifact. The native **Get a Summary** module continues to represent the upstream API and continues to fail visibly when that service returns 404. No backend code is changed.

## Setup

1. Build the project with `npm run build`. Import `templates/04-transcript-to-stored-summary.blueprint.json` and its retrieval companion `04b-get-stored-summary.blueprint.json`. Bind the private MeetStream app as described in the development guide.
2. Create a private Data Store using `templates/summary-state.schema.json`. Select the same store in every Data Store module in both workflows. The store holds summary text, bot/transcript IDs, generation time, source and policy; it does not store the transcript.
3. Select your MeetStream connection in the generator's two MeetStream modules. Select the existing Make AI Provider connection in Make AI Toolkit; the template uses the `small` model profile. Make credits and the selected provider's data policy apply.
4. Choose **On demand** scheduling and leave the scenarios inactive. In the first Set multiple variables module, set `enabled=true` and the bot ID. The retrieval companion additionally needs the exact transcript ID from the saved record.
5. Run the generator manually. It selects the latest successful post-call transcript and returns the saved summary. Run the retrieval companion independently to read that exact artifact with no AI request.

Account-bound copies can be built with `npm run templates:bind -- APP_ID CRM_STRUCTURE_ID CALENDAR_STORE_ID SUMMARY_STORE_ID`. The two store arguments are separate; calendar bindings cannot silently redirect summary records into a calendar store. Select connections privately in Make. Source drafts contain no account IDs or credentials and start disabled.

## Storage on a free Make plan

A dedicated summary store is preferred. The test account has only one 1 MB allocation, already used by this project's calendar state. For live verification, optional summary fields were added to that existing schema, without modifying its original fields or records. A `summary:small-v1:` prefix plus separate SHA-256 digests of bot and transcript IDs isolates summary keys from calendar records. Reusing this arrangement is optional: configure a dedicated store when capacity allows. If sharing, add the supplied optional summary fields to the existing schema; do not replace the calendar schema with the summary-only schema. Storage exhaustion is a visible error; no automatic deletion is performed.

## Behavior and limits

- Empty, incomplete or over-60,000-character transcripts fail before AI generation. The workflow does not truncate or silently summarize a partial transcript. Streaming/captions-only jobs need a separately supported input path.
- Repeat runs with the same bot/transcript/policy retrieve the saved summary and skip AI. A new successful transcript gets a different record. Existing summaries are not overwritten. Do not edit a successful transcript in place and expect the same ID to invalidate this cache; use a new transcript ID or an explicitly reviewed policy revision.
- Only a nonempty summary of at most 20,000 characters is stored. The stored record is read back and checked for matching bot/transcript IDs, `summary_source=make_ai_toolkit`, `summary_policy=small-v1`, content and generation time before returning it.
- Runs are sequential within this scenario. Use one generator per store/policy. Two independent generators can both spend AI credits before one loses the no-overwrite insert; replay reads the stored winner. This is not an account-wide lock.
- A failure after AI generation but before successful storage can require generation again. A failure after storage is recovered by rerunning from the start. No incomplete-execution Retry/Break handlers are used; the source drafts keep execution data confidential.
- The AI summary is a draft for review. Relative dates such as “tomorrow” remain relative; the workflow does not infer deadlines, owners or facts absent from the source. It provides no guarantee that AI output is factually perfect or immune to instructions spoken in a transcript.

Outputs are `bot_id`, `transcript_id`, `summary`, `summary_source`, `summary_policy` and `generated_at`. The retrieval companion does not call MeetStream or an AI model; missing or incompatible records fail visibly.
