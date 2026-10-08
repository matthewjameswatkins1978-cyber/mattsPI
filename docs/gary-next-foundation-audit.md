# Gary Next — Foundation audit (Packet 001)

**Recorded 2026-10-08.** Baseline: `D:\Projects\mattsPI`, `feature/gary-pi-compaction-integration` at `8a7e73c1332ec2c64c08d4c1f55f19f8ed220155` (clean). Source only: installed Gary, live profile, credentials and Omen were not inspected or changed.

## Baseline and ownership

Matthew-owned MIT Electron app (`@pi-gui/desktop`). Three worktrees matter:
- Baseline: app 1.0.2-rc.2, Pi SDK family 1.1.0.
- Rabbit acceptance worktree `D:\Projects\gary-pi-rabbit-finish-01\mattsPI` at `6852c9f`: integration-test/docs/local artifact-preparation changes only.
- `feature/gary-pi-updater-stop-resume` at `73d9dde`: older app 1.0.1 / SDK `^0.87.1`; removes managed SDK runtime/updater and Rabbit Settings relative to baseline while adding branding, presets and Studio lifecycle commands. Do not integrate wholesale; selectively port desired changes to the 1.1.0 line.

Architecture: renderer → browser-safe contracts → narrow preload/validated IPC → Electron main and bounded owners → portable session/catalog packages → thin Pi SDK adapter → upstream Pi. `DesktopAppStore` is the composition root. See [architecture](architecture.md), [host-boundary guard](../scripts/check-host-boundary.mjs), [state-owner guard](../scripts/state-owner-boundary.test.mjs).

Versions/tooling: pnpm 10.25, Electron 37.10.3, React 19, TypeScript 5.9, Playwright. App and SDK versions are independent. Windows CI checks packaging, not full UI; macOS is primary UI target, Linux runs core Electron tests.

## Reusable architecture

- **SDK/runtime:** [pnpm-workspace.yaml](../pnpm-workspace.yaml) is 1.1.0 authority. Packaged main requires external app-data runtime; [sdk-runtime.ts](../packages/pi-sdk-driver/src/sdk-runtime.ts) verifies manifest/API family; [sdk-runtime-manager.ts](../packages/pi-sdk-driver/src/sdk-runtime-manager.ts) stages verified stable updates, activates on launch and retains rollback. Checkout build manifest is 1.1.0; that does not prove installed runtime. Desktop release checker only announces app updates; SDK updater is separate.
- **Providers/models:** Pi supplies built-ins/auth; driver adds extension providers and custom `models.json`. Auth/availability plus global or project `enabledModels` filters the picker. Defaults/thinking/filter are global in agent settings or project-scoped in `<workspace>/.pi/settings.json`; `models.json`/`auth.json` are in agent dir. Custom endpoint UI is `openai-completions`; API-key setup uses an explicit provider allowlist. See [runtime supervisor](../packages/pi-sdk-driver/src/runtime-supervisor.ts), [custom provider store](../packages/pi-sdk-driver/src/custom-provider-store.ts), [model Settings](../apps/desktop/src/features/settings/settings-models-section.tsx), [provider test](../apps/desktop/tests/core/provider-settings.spec.ts).
- **Skills/extensions:** Pi package/resource manager owns discovery and loading; Gary exposes source/scope/enabled state, commands/tools and diagnostics, and delegates toggles to Pi. Extensions may register providers. Load errors/conflicts surface, but extension code is not OS-sandboxed. See [resource projection](../packages/pi-sdk-driver/src/runtime-supervisor.ts), [extension bridge](../packages/pi-sdk-driver/src/desktop-extension-bridge.ts), [skills test](../apps/desktop/tests/core/skills-settings.spec.ts), [extensions test](../apps/desktop/tests/core/extensions.spec.ts), [view security test](../apps/desktop/tests/core/extension-view-security.spec.ts).
- **State:** default user data `%APPDATA%\Gary Pi`; agent dir `<userData>\agent`, both env-overridable. App data owns catalogs/UI/Studio/worktree/review/checkpoint/attachment state; Pi agent config is separate from project `.pi`. No architecture decision ledger was found; Studio `studio-runs.json` is live mission state, so this is the review record.
- **Studio/review/recovery:** validated durable runs, host-checked dispatch/transitions, restart reconciliation, explicit `/studio start`, and worker/session evidence exist. Review uses separate checkpoint objects and immutable comparisons. Instructions/worktrees are workflow/source-control boundaries, not process sandboxing. See [Studio extension](../examples/desktop-extensions/matthew-way-studio/index.ts), [run contract](../apps/desktop/contracts/studio-runs.ts), [recovery](../apps/desktop/contracts/studio-recovery.ts), [run store](../apps/desktop/electron/studio/studio-run-store.ts), [review owner](../apps/desktop/electron/workbench/review-owner.ts), [checkpoint store](../apps/desktop/electron/workbench/checkpoint-store.ts).

## Decisions and next slices

**Reuse unchanged:** Pi catalogue/resource loading, typed IPC, session/catalog owners, external SDK runtime, extension host, Studio/review/recovery spine and existing GUI tests. **Do not add:** second runtime/catalogue/loader/database or new sandbox system without evidence. Correct stale 0.87.1 wording in [architecture.md](architecture.md); keep compatibility seams until SDK 1.1 tests prove removal safe.

1. **First PR:** correct stale SDK docs and guard that packaged mode requires managed runtime and pinned family. Verify [SDK tests](../packages/pi-sdk-driver/test/sdk-runtime.test.mts), [updater tests](../packages/pi-sdk-driver/test/sdk-runtime-manager.test.mts), packaged dependency checks and typecheck; no UI/profile changes.
2. If review finds a concrete gap, improve existing Settings provenance/availability/load diagnostics without a second registry.
3. Port desired provider presets or stop/resume separately onto 1.1.0 with focused Electron tests.
4. Run disposable packaged-profile/provider/worker/restart acceptance; separate fixture evidence from authorized real-provider tests.

**Stop point:** no implementation begun. Review requested on 1.1.0 as baseline and whether Settings needs more provenance. No code tests run for this audit.