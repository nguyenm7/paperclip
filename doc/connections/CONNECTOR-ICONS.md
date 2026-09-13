# Connector icons

The durable rule is **fixed gray Paperclip frame + authentic vendor artwork + explicit theme variants + optical fit + provenance**. Use the shared `AppLogo` and local registry for every connector surface. Brand-library membership does not enable an app, grant access, or change catalog visibility.

## Add or update artwork

1. Find the stable app slug in `ui/public/brands/apps/manifest.json`. Preserve it and the product name. Add explicit name aliases only when unambiguous; owner-qualified connection names should pass `brandKey` from their definition. Do not guess a provider from a substring.
2. Select an authentic compact vendor mark. Keep the original file and exact URL. Record `sourceClass`, source bundle-relative `sourceFile`, `sourceUrl`, acquisition date and SHA-256 for **each** theme. Distinguish vendor-sourced files, supplied artwork, board-selected exports, retained upstream files and Simple Icons derivatives. A Paper export URL establishes which file was selected; it does not independently establish vendor authorship. Historical `officialSourceUrl` is a vendor reference, not verification of a replacement file.
3. Declare `localAsset`, `darkAsset` and `themeMode` (`same` or `pair`). Same artwork explicitly points both fields at one file. A resolved local mark owns both themes; a remote dark URL cannot override it. Preserve authentic black/white companions. Export complete vendor theme groups unchanged when an original uses a theme media query, then let the product theme select the file. Do not CSS-invert, recolor, trace, stretch, crop arbitrarily, or wrap a raster in SVG.
4. Keep the existing `bg-muted rounded-lg` outer frame, caller width/height, alignment and caller border. Native vendor tiles, gradients, white internal details and aspect ratios stay inside it. Notion's white body belongs to its glyph. No transparent, full-bleed or protective outer-surface overrides. `opticalFit: standard` currently means the existing contained image with `p-1.5`; record any unresolved small/weak mark in `selection`, then assess it at actual size. A new optical fit needs an explicit token-backed inner-image rule and visual evidence, without changing the frame.
5. Run the importer against an extracted, reviewed source bundle. It validates the entire batch and hashes before writing. Dry run is the default; `--apply` copies exact selected bytes. Do not overwrite unrelated registry rows when importing a newer source catalog.

```sh
node scripts/import-app-brand-assets.mjs --source-dir /path/to/extracted-bundle
node scripts/import-app-brand-assets.mjs --source-dir /path/to/extracted-bundle --apply
node scripts/check-app-brand-assets.mjs
node --test scripts/app-brand-validation.test.mjs
node scripts/ingest-app-definitions.mjs --branding-only
node scripts/ingest-app-definitions.mjs --branding-only --check
pnpm exec vitest run ui/src/lib/app-brand-assets.test.ts ui/src/pages/apps/AppLogo.test.tsx ui/src/pages/apps/AppLogo.brand-assets.test.tsx packages/shared/src/app-definitions.test.ts
pnpm check:token-gates
pnpm --filter @paperclipai/ui typecheck
pnpm --filter @paperclipai/ui build
```

`--branding-only` regenerates only branding in existing app definitions, without requiring the external connector capture corpus or adding app definitions. The normal full ingest uses the same manifest mapping. Generic MCP/API-key definitions keep their generic icons. Neither generator mode interprets a brand-only registry row as permission to activate a connector.

The structural validator rejects missing files/hashes/provenance, incomplete pairs, ambiguous aliases, external SVG resources, scripting, event handlers, animation, theme media queries and raster wrappers. It is a conservative rejection check, not a general SVG sanitizer or proof of optical quality. Genuine PNG files remain supported. Intrinsic width/height are valid when a vendor file has no viewBox; do not fabricate geometry just to satisfy tooling.

## Visual proof

Use Storybook `Apps/Canonical icon registry/Light` and `/Dark` for the **synthetic test fixtures** at 24/28/32/36/44/48px. The first row group is Gmail, Calendar, Slack and Stripe. Verify all images load without third-party requests, retain native details and remain recognizable. Compare computed wrapper width, height, radius, fill and border with the pre-change checkout in both themes. Preserve decorative `alt=""` next to readable names and image-error fallback.

Then use the task's managed, isolated, quarantined, seeded runtime to inspect Discover, connected apps, detail/setup, approval cards, sidebar and agent-access references. Only represent supported runtime data as real product evidence. Do not run provider actions for icon QA. Verify `/api/health`, root/apps responses, populated company data, seed-manifest completion, isolated config/database/ports and OS listener PID/cwd. A healthy response alone does not establish the checkout identity. Upload screenshots and the evidence/exception report to the task. Report missing surfaces or measurements explicitly; synthetic stories do not substitute for real caller verification.

## September 11 selection exceptions

The manifest's `selection` and per-theme `provenance` are the complete ledger. The approved bundle hash is `8297f781858b44cc43edd7824725e5c700542adc9a9f563610d5b42675d54485`.

- Cloudinary and PostHog retain upstream white dark marks; Netlify retains its teal dark mark. Mixpanel retains purple light and selects the supplied white dark mark.
- Context7, Kernel, Box, Egnyte, O'Reilly, Xero, beehiiv, Candid and Local Falcon retain upstream sources while sourcing remains deferred. Resend and Sentry retain their baseline pairs until clear-space/optical sizing is verified. Genuine rasters are intentional interim files.
- Manufact uses the complete existing vendor groups exported separately; AgentMail uses the board's supplied compact SVG in both themes, with original black/white artwork and added viewBox only. AgentMail provenance is not vendor-verified.
- Google People and Workspace Search deliberately share Google G artwork as parent-brand fallbacks while retaining separate IDs and names. Image-byte uniqueness is not an invariant.
- Jam.dev is brand-only in this baseline. No Jam app definition or connector capability is created.

## Onboarding pressure test

These are workflow examples, not connector implementations or claims that new artwork has been sourced.

| Candidate | Apply the guide | Evidence needed before accepting art |
| --- | --- | --- |
| Granola | Check for an existing stable identity first; source a compact authentic symbol and explicit theme choices. | Exact source bytes/URL, provenance class and small-size render on both gray frames; retain a source gap if unavailable. |
| Circleback | Check normalized names and aliases for collisions before adding a brand-only row. Avoid substituting a generic circular arrow. | File hashes, native aspect ratio, contrast-safe theme pair or proven same-artwork choice. |
| Paper.design | Keep the product name distinct from Paperclip; choose an explicit stable slug and alias only if needed. | Provenance for the actual mark, internal white details retained, no protective frame override. |
| Figma | First check existing registry/definition coverage; keep multicolor vendor artwork intact. Brand sourcing does not install a Figma plugin or enable connector tools. | Exact source record, genuine vector/PNG validation, both theme references, generator idempotence and caller screenshots. |

Each example can stop with a recorded source gap while other ready artwork proceeds. No additional approval workflow is introduced by this reference.
