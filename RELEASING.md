# Releasing MDXera ERP

This repo ships installers via GitHub Releases and auto-updates the installed
app through the Tauri updater. End users see "Check for updates" in
**Settings → System & Updates** and a one-time notification at app boot if a
newer build is available.

## One-time setup (per repository)

These have to be done once on `mridupawanborah790-gif/mdxera-offline`.

### 1. GitHub Actions secrets

Open `Settings → Secrets and variables → Actions → New repository secret` and
add **two required** secrets:

| Name                                 | Where to find the value                                                  |
|--------------------------------------|--------------------------------------------------------------------------|
| `TAURI_SIGNING_PRIVATE_KEY`          | Paste the entire contents of `.updater-secrets/updater.key`              |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `mdxera-updater-key-2026` (or your own if you regenerated the key)       |

The matching public key is already baked into
[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) — clients verify
every update against it. **Never commit the private key.** It lives only in
`.updater-secrets/` (gitignored) and in this GitHub secret.

### 2. Optional — macOS notarization

Without these, macOS users see a Gatekeeper warning ("MDXera ERP can't be
opened") on first launch. Auto-update still works. Add when you're ready:

| Name                       | Description                              |
|----------------------------|------------------------------------------|
| `APPLE_CERTIFICATE`        | base64-encoded `.p12` Developer ID cert  |
| `APPLE_CERTIFICATE_PASSWORD` | Passphrase for the `.p12`              |
| `APPLE_SIGNING_IDENTITY`   | e.g. `Developer ID Application: ACME…`   |
| `APPLE_ID`                 | Apple ID email                           |
| `APPLE_PASSWORD`           | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID`            | Apple Developer Team ID                  |

> **Tip:** To get the base64 string for `APPLE_CERTIFICATE`, run this on your
> exported `.p12` file: `base64 -i my-cert.p12 | pbcopy` (macOS) or
> `[Convert]::ToBase64String([IO.File]::ReadAllBytes("my-cert.p12"))` (Windows).

## Cutting a release

```bash
# 1. Bump the version in three places (keep them identical):
#    - package.json            "version"
#    - src-tauri/Cargo.toml    package.version
#    - src-tauri/tauri.conf.json  "version"
# 2. Commit the version bump.
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v1.2.3"

# 3. Tag and push. The release.yml workflow takes over from here.
git tag v1.2.3
git push origin main --follow-tags
```

The GitHub Actions workflow will:

1. Build the Windows installers (`.msi` + `.exe` NSIS) and macOS bundles
   (`.dmg` + `.app`, Intel + Apple Silicon).
2. Sign every bundle with the updater key.
3. Create a GitHub Release containing every installer **and** `latest.json`
   — the manifest the installed app polls.

The whole pipeline takes ~10–15 minutes per platform. Watch progress under
`Actions → Release`.

## What end users see

- **First time:** Download the installer from the GitHub Release and run it.
  Auto-updates only work for installs that came **from** v1.0.0-onwards of
  this codebase — older installs of the legacy app won't auto-migrate.
- **From then on:** App boot does a silent check. If a newer version exists,
  a non-blocking notification appears: *"Update available: v1.2.3 — open
  Settings → System & Updates to install."* The user clicks the panel,
  reviews the release notes, hits Install, and is prompted to restart when
  the download completes.

## Local testing tips

- Build a local Tauri release: `npm run tauri:build`. The output lands under
  `src-tauri/target/release/bundle/`.
- The updater check runs from the desktop shell only — in `npm run dev`
  (browser) the service no-ops, so you'll see "dev" as the version and the
  button reports "up to date".
- To test a real update flow end-to-end, ship two consecutive tagged releases
  (e.g. `v0.0.1` then `v0.0.2`), install v0.0.1 locally, then trigger the
  check from the Settings panel.

## When something goes wrong

| Symptom                                                  | Likely cause                                                   |
|----------------------------------------------------------|----------------------------------------------------------------|
| Workflow fails at "Build & publish" with "signing failed" | `TAURI_SIGNING_PRIVATE_KEY` or password secret is wrong.       |
| Updater says "no update found" right after release       | The release is still publishing assets — wait 1–2 min and retry. |
| In-app updater errors with "Signature verification failed" | Public key in `tauri.conf.json` doesn't match the private key the workflow used. |
| macOS users blocked at first launch                     | Notarization secrets missing (or expired Developer ID cert).   |
| Windows SmartScreen warns "Unrecognized publisher"      | No EV / OV code-signing cert configured. Separate from the updater key. |

## If you lose the private key

You can't sign new updates with the same identity. Recovery:

1. Generate a new keypair (`npx @tauri-apps/cli signer generate -w
   .updater-secrets/updater.key --force`).
2. Replace the `pubkey` in `src-tauri/tauri.conf.json`.
3. Update the GitHub secret with the new private key.
4. Cut a new release.
5. **Every existing user has to reinstall manually** — their installed
   binaries trust only the *old* public key.

Back the `.updater-secrets/` folder up to a password manager or encrypted
vault before you regret it.
