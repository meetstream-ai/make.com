# Release checklist

1. Run `npm ci`, `npm run verify` and `npm audit`. Check that generated app definitions and scenario blueprints match the source.
2. Use the manual verification workflow to package the reviewed commit. Follow the [private installation guide](development.md) to apply the components in a development Make organization.
3. Check connection setup, authenticated reads, the bot lifecycle, signed webhook delivery, and the relevant blueprints with synthetic data. Verify provider actions in a test workspace before enabling production scenarios.
4. Verify relay TLS, retries and recovery on the intended host. Review the [relay guide](webhook-relay.md) and [workflow setup](../templates/README.md).
5. Record Make review eligibility and complete the publication checklist in Make before listing the app. See [Make's review prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites).
