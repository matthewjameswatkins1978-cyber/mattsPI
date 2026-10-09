# Gary Pi context integration (isolated development)

This isolated branch prepares Rabbit Garden and the accepted remote-compaction capability repair for a future Gary Pi review. Package artifacts and the disposable profile live under the ignored `.cache/gary-pi-rabbit-garden-01` directory. The live Gary Pi installation, credentials, session history, and active Omen mission are not modified.

## Source provenance and package identity

- Rabbit Garden source: `D:\Projects\rabbit-garden-source`, commit `36945af03ec3e2f9e7dc122091d215d829dc9226`, based on the recovered V2 source. The packaged tarball SHA-256 is `3C237B1963168FBC0DFA490E49F87714E38EB97A093E3BA843A902A6251728EF`; the manifest also records npm integrity and runtime dependency hashes. The original `cadba3a93f6197db1ef2c4d73f75985f436184c0` Git object was unavailable in the fresh remote clone, so no original Git ancestry is claimed.
- Pi compaction extension: `D:\Projects\gary-pi-rabbit-finish-01\pi-extensions-capability-repair`, commit `b3702b1b9ccdb6b5ca3405d73ef23e06618d1ef4`, descended from accepted `b9fe82d76faf13d80cab23a44c1a445c33a3ffd6` (which includes `e141ab25beb7529839de54ad0363cad61976c557`); the change pins its typecheck family to Pi 1.1.0.
- `@narumitw/pi-codex-compact@0.55.0` is not a source identity: an existing published release uses that same version. The generated tarball is built from the pinned source commit and identified by SHA-256 in `manifest.json`.

The local package artifacts are pinned by absolute extracted package paths in the generated test agent's `settings.json`. The manifest records the two tarball hashes, npm integrity values, package-lock hashes, resolved runtime dependencies, and source SHAs. The test agent has no credentials. The runtime discovers both packages from that agent configuration and loads their entrypoints.

## Rebuild an isolated integration profile

Requires Node.js/npm, Corepack/pnpm, Git, and tar, plus the exact component checkouts above. Choose a new output directory; the builder refuses a live profile/application path or a non-empty output directory.

```powershell
node scripts/gary-pi-context/prepare-local-integration.mjs `
  --rabbit-repo 'D:\Projects\rabbit-garden-source' `
  --extensions-repo 'D:\Projects\gary-pi-rabbit-finish-01\pi-extensions-capability-repair' `
  --output 'D:\Projects\mattsPI-rabbit-garden\.cache\gary-pi-rabbit-garden-01'
```

Prepare the isolated profile from the current model and extension settings. This deliberately omits `auth.json`, sessions, MCP configuration, and Studio mission state:

```powershell
$root = 'D:\Projects\mattsPI-rabbit-garden\.cache\gary-pi-rabbit-garden-01'
$sourceAgent = Join-Path $env:USERPROFILE '.pi\agent'
$agent = Join-Path $root 'agent'
foreach ($name in @('settings.json', 'models.json', 'models-store.json', 'studio-models.json')) {
  Copy-Item (Join-Path $sourceAgent $name) (Join-Path $agent $name) -Force
}
Copy-Item (Join-Path $sourceAgent 'npm') (Join-Path $agent 'npm') -Recurse -Force
$settings = Get-Content (Join-Path $agent 'settings.json') -Raw | ConvertFrom-Json
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$settings.packages = @($settings.packages | Where-Object { $_ -notmatch 'rabbit-pi-compactor|pi-codex-compact' })
$settings.packages += @($manifest.artifacts.rabbit.packagePath, $manifest.artifacts.compact.packagePath)
$settings | ConvertTo-Json -Depth 100 | Set-Content (Join-Path $agent 'settings.json') -Encoding utf8
```

Build a Windows unpacked package directory (this does not create an installer):

```powershell
corepack pnpm --filter @pi-gui/desktop build
Push-Location apps/desktop
node scripts/package-windows.mjs --win --dir --publish never --config.npmRebuild=false --config.win.signAndEditExecutable=false
Pop-Location
```

The local `signAndEditExecutable=false` override avoids Windows symlink privilege failures in the unsigned development build; it does not change repository packaging settings. The executable is `apps/desktop/release/win-unpacked/gary-pi.exe`.

Run the disposable Electron acceptance test with that generated profile:

```powershell
$env:GARY_PI_CONTEXT_ROOT = 'D:\Projects\mattsPI-rabbit-garden\.cache\gary-pi-rabbit-garden-01'
$env:PI_APP_TEST_MODE = 'foreground'
$env:PI_APP_TEST_EXECUTABLE = 'D:\Projects\mattsPI-rabbit-garden\apps\desktop\release\win-unpacked\gary-pi.exe'
$env:PI_APP_TEST_SDK_RUNTIME_DIR = 'D:\Projects\mattsPI-rabbit-garden\apps\desktop\build\pi-sdk-runtime\1.1.0'
$env:PI_APP_TEST_RENDERER_TIMEOUT_MS = '90000'
corepack pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/gary-pi-context-integration.spec.ts --workers=1 --timeout=180000
```

The production test launches the packaged Gary executable with isolated user data, copied settings/model registries from the real Pi profile, no credentials, and a disposable workspace/session. The copied settings replace only the old Rabbit and Codex-compaction package entries with the generated local artifacts. The test verifies archive hashes, exact loaded package paths, the saved Qwen model/thinking route, Rabbit Auto/Manual/Off/Garden controls, `/rabbit status`, Garden-mode selection, and persistence after restarting the app. Pi reported zero measured usage for the fresh empty session; when Pi provides no usage snapshot, Rabbit reports `unknown`. Garden lifecycle behavior, pressure arithmetic, and provider fallback are verified with deterministic component fixtures.

## Prepared live installation and rollback (not authorized or performed)

Before a future approved installation, first create a dated backup of the Studio program directory and `%USERPROFILE%\.pi\agent`, including settings and session data. Preserve the manifest and exact generated package directories. Install by copying the verified package artifacts into a stable versioned directory and configuring those immutable local package paths; do not use the colliding registry version as identity. Launch a disposable session and verify `/rabbit status`, settings, and restart before opening any existing mission.

Rollback by restoring the saved Studio program directory and agent profile/settings/session backup, then launch and verify the prior version. Keep backups until an explicit post-install acceptance. No installation command is included here because live installation remains unauthorized.

Current branch intentionally has no published package version and no remote dependency reference. A release must use a new registry version confirmed unused at release time or an approved immutable remote commit/artifact reference with recorded integrity.
