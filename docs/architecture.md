# Architecture and release workflow

| Layer | Make implementation | MeetStream reference |
|---|---|---|
| Credentials and API actions | The native connection supplies token authentication. App module definitions own inputs, API mappings, response shapes and errors. The pinned contract captures the shared defaults. | [Official n8n plugin at 5319cd4](https://github.com/meetstream-ai/n8n-plugin/tree/5319cd482c3cb17b836c0dd72d307117b1919729) |
| Workflow recipes | Scenario blueprints map native actions into calendar, CRM, Drive and stored-summary workflows. Account bindings are generated locally. | [n8n workflow library](https://github.com/meetstream-ai/n8n-plugin/tree/5319cd482c3cb17b836c0dd72d307117b1919729/templates) |
| Events | The relay verifies the workspace signature over raw bytes, queues accepted deliveries in SQLite, then sends a signed envelope to the native Make trigger. Each deployment targets one Make webhook. | [MeetStream signing guide](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification) |
| Build and validation | Source generators produce the native app JSON and scenario blueprints. CI checks dependency integrity, rebuilds, runs tests, checks for generated-file drift and audits dependencies. | [n8n CI](https://github.com/meetstream-ai/n8n-plugin/blob/5319cd482c3cb17b836c0dd72d307117b1919729/.github/workflows/ci.yml) and [unified plugin validation](https://github.com/meetstream-ai/meetstream-plugin/blob/5f52f4022938005bf0f07252930699e5beb385a5/.github/workflows/validate.yml) |

The official [Make repository](https://github.com/meetstream-ai/make.com/tree/fb0c1ef45dc0c0de27b3ef8cc7260264a62c5ae9) defines the integration scope and contains a README. The official n8n plugin is the closest API and workflow reference. The [unified plugin](https://github.com/meetstream-ai/meetstream-plugin/tree/5f52f4022938005bf0f07252930699e5beb385a5) and [Node SDK](https://github.com/meetstream-ai/meetstream-node/tree/5e977a9191b1af792d7eb62b2a8b129839c72e53) serve different runtimes. Make runs these actions through its own SDK and connection model.

The shared API defaults include audio-only capture and explicit transcription mode. Make uses a required deduplication key to handle retried creates. The calendar draft explicitly requests video for Drive archiving. The existing Get a Summary module is retained for saved scenario mappings. The working summary workflow uses Make AI and Data Store.

1. Run `npm ci`, `npm run verify`, and `npm audit`. Commit the generated app definitions and blueprints alongside their source.
2. Pull requests and pushes to main run CI on Node 22.13.0 and Node 24. Dependency updates use the same checks.
3. After the commit is on GitHub, run **Verify Make app source** manually to obtain an archive tied to that commit. The archive includes the native definitions, blueprints, relay, tooling and documentation.
4. Apply the components to a private Make app, bind scenario connections and run the relevant QA. Follow the [Make release checklist](release.md) for any separate publication decision.
