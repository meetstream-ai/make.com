# Make schema snapshots

Captured October 13, 2026 from the JSON OpenAPI fragments in Make's official developer documentation:

- `communication`, `parameters`, `interface`: https://developers.make.com/api-documentation/api-reference/sdk-apps/modules
- `base`: https://developers.make.com/api-documentation/api-reference/sdk-apps

Only JSON formatting was changed. These schemas check code shape, not IML execution. The webhook update schema in the public API documentation is incomplete; webhook behavior must also be verified in the Apps Editor. Refresh these snapshots when Make changes its SDK. The local expression harness intentionally supports only the expressions used here and does not certify behavior on Make.
