# Agent instructions

This file is the central source for agent workflow, validation, and release
instructions. See [README.md](README.md) for plugin behavior, local setup, and the
source-file guide. Keep agent instructions here rather than duplicating them in
the README.

## Editing and generated files

- Edit TypeScript and supporting inputs in `src/`; regenerate runtime JavaScript
  with `npm run build`. Do not hand-edit generated JavaScript in
  `wikipedia.crosspoint-plugin/`.
- Commit regenerated payload files with their source changes. Plugin Hub installs
  the loose files from the immutable release tag and does not run our build or
  use this repository's installation ZIP.
- Keep exactly one direct-child `*.crosspoint-plugin` payload directory. Declare
  every installed file in its `manifest.json` and keep the plugin ID `wikipedia`.
- Keep changes within this plugin repository unless the task explicitly calls
  for reader firmware or Plugin Hub changes.
- Save investigation artifacts and temporary screenshots under `.context/`.
  README screenshots belong in `docs/screenshots/`; label simulator captures
  accurately and refresh them when the documented UI changes.

## Validation

Use a focused validation loop for bug fixes:

1. Reproduce the specific bug with one article or a small fixture.
2. Verify the fix at the layer responsible for the bug. For reader layout issues,
   prefer a targeted reader layout probe when practical.
3. Run relevant regression tests and build/type checks. Validate a regenerated
   EPUB when the change affects EPUB output.

Scale validation to the change. Reserve the full article corpus, both browsers,
transfer protocols, and broad EPUB validation for changes that affect conversion
broadly or the final pre-merge check. Run the comprehensive check once after a
batch of fixes; repeat only when new changes or failures justify it. Do not add
tests that merely mirror the implementation or test trivial, reversible edits.

Report what was verified and any material limits. Do not claim physical-device
validation when only a host probe or browser was used.

## Validation commands

- `npm run check`: TypeScript checks, build, payload contract, and font checksums.
- `npm test`: deterministic Chromium and mobile WebKit tests, including simulated
  reader transfers. Install browsers with `npx playwright install chromium webkit`.
- `npm run test:epub`: validate browser-test EPUBs with W3C EPUBCheck; requires
  Java 21 or newer. The tool downloads a checksum-pinned EPUBCheck distribution.
- `npm run package`: repeat the build/contract checks and create the installation
  ZIP in `dist/`.
- `npm run check:fonts -- path/to/article.epub`: audit codepoints against all
  bundled font sizes and styles. Failures include surrounding text. A passing
  corpus does not prove coverage of every English Wikipedia article.

Run `npm run test:articles` for the 26-article Wikipedia audit. It uses actual
article revisions, Chromium and WebKit, real image and license responses, local
EPUB downloads, and simulated WebSocket and HTTP reader transfers. It checks every
XHTML section for validity, bounded size, and horizontal overflow at 480 pixels.
The corpus and unusual structures are listed in `tools/audit-articles.json`.
Source snapshots, cached network responses, EPUBs, screenshots, and `results.json`
are saved under `.context/complex-articles/`. Remove that directory to refresh the
sources. This network-dependent audit is separate from deterministic CI tests.
Use `-- --no-images` to skip image fetching or `-- --chromium` for one engine.
Run W3C EPUBCheck on the generated corpus afterward:

```sh
npm run test:epub -- .context/complex-articles/*-chromium.epub \
  .context/complex-articles/*-webkit.epub
```

## Physical reader verification

Browser tests simulate Wikipedia, file listings, HTTP upload, and the exact
WebSocket protocol. They inspect generated EPUB structure, XML, reference removal,
sanitization, image dimensions, credits, duplicate protection, and transfer failures.
They do not replace hardware testing.

Before release, use iPhone Safari and Android Chrome on shared Wi-Fi to check cold
File Manager load, search/preview responsiveness, import cancellation and retry,
and a second import with explicit replacement. On the X4, check article layout,
image scaling, table readability, section navigation, absence of reference clutter,
and Library discovery. Try a short article, Maputo, a long article, and an article
with non-Latin text supported by the installed fonts. Record network conditions,
bundle size, and observed load/import times; do not infer page-load speed from
upload throughput.

## Release to Plugin Hub

This repository follows [Plugin Hub's publishing contract](https://github.com/crosspoint-reader/crosspoint-plugin-hub/blob/main/PLUGIN_HUB_CONTRACT.md):

- Public repository with the `crosspoint-plugin` GitHub topic.
- Exactly one direct-child payload: `wikipedia.crosspoint-plugin/`.
- Matching manifest ID (`wikipedia`), explicit runtime files, and semantic version.
- Compiled payload files included in the release's Git snapshot.
- Stable, non-draft GitHub Release with a matching tag, such as `v0.1.0`.

To publish after review and device testing:

1. Update both package and manifest versions for every runtime change.
2. Run `npm run check`, `npm test`, `npm run test:epub`, and `npm run package`; commit the built payload.
3. Push the reviewed commit, create a matching new `vMAJOR.MINOR.PATCH` tag, and push it.
4. The release workflow validates the payload and tests, then publishes a stable
   GitHub Release and installation ZIP.
5. Plugin Hub discovers the release on its scheduled catalog refresh (every three
   hours). No Hub PR or whitelist exception is required. Never reuse a release tag.

Before tagging, also ensure `package-lock.json` agrees with the package version
and the rebuilt payload is committed. Verify a clean rebuild with
`git diff --exit-code -- wikipedia.crosspoint-plugin` after `npm run check`.
A source-only merge, a pushed tag without a successful Release workflow, or an
uploaded ZIP alone does not publish an automatically discovered Hub update.

After publishing, verify that the Release workflow succeeded and the GitHub
Release is stable (neither draft nor prerelease). Check that the Hub catalog
contains the new version after its refresh; report any pending refresh or failed
publication rather than claiming users can already install it. Do not reuse or
move published tags. Follow the user's requested scope for pushing and publishing;
preparing a release does not by itself authorize publishing it.
