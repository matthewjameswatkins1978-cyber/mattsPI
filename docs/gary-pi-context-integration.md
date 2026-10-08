# Gary Pi context integration (isolated development)

This branch integrates the accepted Rabbit V2 and remote-compaction capability repairs into the desktop Settings surface. All package output and test profiles live under the ignored `.cache/gary-pi-context*` directories. The installed Pi Studio profile, credentials, sessions, and paused Omen mission are not read or modified.

## Source provenance and package identity

- Rabbit V2 source: `D:\Projects\rabbit-pi-compactor-v2`, commit `cadba3a93f6197db1ef2c4d73f75985f436184c0` (includes `f48c1d25d176342301cbba08048ee24d275623f0`).
- Pi compaction extension source: `D:\Projects\pi-extensions-capability-repair`, commit `b9fe82d76faf13d80cab23a44c1a445c33a3ffd6` (includes `e141ab25beb7529839de54ad0363cad61976c557`).
- `@narumitw/pi-codex-compact@0.55.0` is not a source identity: an existing published release uses that same version. The generated tarball is built from the pinned source commit and identified by SHA-256 in `manifest.json`.

The local package artifacts are pinned by absolute extracted package paths in the generated test agent's `settings.json`. The manifest records the two tarball hashes, npm integrity values, package-lock hashes, resolved runtime dependencies, and source SHAs. The test agent has no credentials. The runtime discovers both packages from that agent configuration and loads their entrypoints.

## Rebuild an isolated integration profile

Requires Node.js/npm, Corepack/pnpm, Git, and tar, plus the exact component checkouts above. Choose a new output directory; the builder refuses a live profile/application path or a non-empty output directory.

```powershell
node scripts/gary-pi-context/prepare-local-integration.mjs `
  --rabbit-repo 'D:\Projects\rabbit-pi-compactor-v2' `
  --extensions-repo 'D:\Projects\pi-extensions-capability-repair' `
  --output 'D:\Projects\mattsPI\.cache\gary-pi-context-next'
```

Run the disposable Electron acceptance test with that generated profile:

```powershell
$env:GARY_PI_CONTEXT_ROOT = 'D:\Projects\mattsPI\.cache\gary-pi-context-next'
$env:PI_APP_TEST_MODE = 'foreground'
corepack pnpm --dir apps/desktop exec playwright test tests/production/gary-pi-context-integration.spec.ts --workers=1
```

The test starts the desktop development runtime with isolated user data, agent settings, session, and mission directories. It checks the artifact hashes and package locations reported by the running Pi runtime, settings actions, `/rabbit status`, and restart persistence. Because no authenticated provider is configured, the runtime status must honestly show context as unknown; context arithmetic and provider capability/fallback logic are covered by component tests with fixtures instead.

## Prepared live installation and rollback (not authorized or performed)

Before a future approved installation, first create a dated backup of the Studio program directory and `%USERPROFILE%\.pi\agent`, including settings and session data. Preserve the manifest and exact generated package directories. Install by copying the verified package artifacts into a stable versioned directory and configuring those immutable local package paths; do not use the colliding registry version as identity. Launch a disposable session and verify `/rabbit status`, settings, and restart before opening any existing mission.

Rollback by restoring the saved Studio program directory and agent profile/settings/session backup, then launch and verify the prior version. Keep backups until an explicit post-install acceptance. No installation command is included here because live installation remains unauthorized.

Current branch intentionally has no published package version and no remote dependency reference. A release must use a new registry version confirmed unused at release time or an approved immutable remote commit/artifact reference with recorded integrity.
