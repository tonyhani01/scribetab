# Releasing ScribeTab

This document describes the release flow: how a version is prepared locally,
how it is pushed, and how CI verifies, packages, and publishes it.

## Release flow

1. **Prepare the release locally:**

   ```sh
   pnpm release patch   # or minor | major
   ```

   This runs `scripts/release.mjs`, which bumps the extension version,
   updates `CHANGELOG.md`, runs checks, then creates a release commit and a
   `vX.Y.Z` tag locally. It never pushes anything.

2. **Review the release commit and tag.** Verify the version bump and the
   changelog entries look right.

3. **Push manually — the deliberate human step:**

   ```sh
   git push origin main vX.Y.Z
   ```

   Pushing the tag is what triggers the release pipeline. Nothing in the
   tooling ever pushes; this is intentional so a release only goes out when a
   human decides it should.

4. **CI takes over** (`.github/workflows/release.yml`, triggered by the tag):

   - Re-checks that the tag matches the extension version.
   - Typecheck and tests.
   - Builds the extension and zips it.
   - Runs the store preflight checks (`scripts/release-checks.mjs`).
   - **Submits to the Chrome Web Store only when enabled** (see below).
   - Creates a GitHub release and attaches the zip.

## Enabling store submission

Store submission is gated on the repo variable `CHROME_PUBLISH_ENABLED=true`
plus the `CHROME_*` secrets. Without them, CI still builds, zips, and creates
the GitHub release — it just skips the upload.

1. Run `wxt submit init` inside `apps/extension` to obtain your Google OAuth
   credentials and Chrome Web Store refresh token.
2. Set the repo secrets:
   - `CHROME_EXTENSION_ID`
   - `CHROME_CLIENT_ID`
   - `CHROME_CLIENT_SECRET`
   - `CHROME_REFRESH_TOKEN`
3. Set the repo variable `CHROME_PUBLISH_ENABLED` to `true`.

## Extension IDs

There are two different extension IDs:

- **Published store ID:** `empcoocfpoihhdjnpnocdgffgdgaknoe`
- **Unpacked / dev ID:** `cambjpbepplcihlihagiheggdkfcpmef`

The store build has its own ID, so any native messaging host install that
targets a store build must pass the store ID explicitly:

```sh
# during host registration
--extension-id empcoocfpoihhdjnpnocdgffgdgaknoe
```

## Preflight checks

`scripts/release-checks.mjs` is a preflight CLI that verifies store asset
dimensions, built-manifest sanity, and zip hygiene before anything reaches
the Chrome Web Store. It exits non-zero on any failure. CI runs it after the
zip step, but you can also run it standalone at any time:

```sh
node scripts/release-checks.mjs
```
