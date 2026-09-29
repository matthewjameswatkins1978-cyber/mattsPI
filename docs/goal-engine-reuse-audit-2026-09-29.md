# Matthew Way Studio: goal-engine reuse audit

**Checked:** 29 September 2026
**Target:** Pi GUI v1.0.1 on Windows 11
**Decision:** Studio remains the sole owner of task state and continuation. Do not install either candidate globally.

## Runtime facts

- The Pi GUI v1.0.1 source lockfile resolves `@earendil-works/pi-coding-agent` 0.87.1. The installed development runtime reports Node v24.19.0.
- Pi GUI's extension bridge supports host dialogs, notifications, status, simple string-line widgets, title changes, and composer text. It deliberately rejects arbitrary `ctx.ui.custom()` terminal UI components and ignores terminal working-indicator calls.
- Pi GUI's native `create_child_thread` takes a prompt and creates a normal child session. It supplies the execution/thread mechanism, not the Studio milestone DAG, exact-SHA review state, live correction map, or continuation policy.

## Candidate comparison

| Candidate                                                                              | Current published package                                                                                                                  | Declared compatibility                                                                                                                                                                                               | Reusable behavior                                                                                                                                 | Fit and risks                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x)                                        | 0.31.9, MIT; Node `>=22.15`; Pi packages `>=0.83.0 <0.88.0`                                                                                | Pi 0.87.1 and Node 24.19 satisfy the declared ranges. This does not prove Windows behavior or the desktop extension UI.                                                                                              | Durable goals/tasks, goal revision, pause/resume, verification contracts, independent audit, configurable model, finite autonomous-run allowance. | Its autonomous-run allowance is unlimited when unset. It owns goal/task state under `.pi/goals` and independently continues on agent lifecycle events. Installing it alongside Studio would create competing task/continuation owners. It also asks its auditor to use `bash`, while Matthew's commissioned Windows agent surface uses PowerShell. GUI widget behavior is only partly portable. Windows live behavior is untested. |
| [pi-goal-list-loop-audit (GLLA)](https://github.com/DraconDev/pi-goal-list-loop-audit) | npm latest 0.38.98, AGPL-3.0-only; Node `>=22.19`; Pi peer versions are `*`. GitHub main declares 0.38.103, ahead of the registry release. | Node requirement is met; wildcard peers do not establish the Pi API contract. The project documents cross-platform timeout/process cleanup but also Linux-specific process-group limits. No Windows GUI proof found. | Durable goal/list/loop supervision, bounded retry and recovery, detached evidence auditor, explicit decision gates, optional workers.             | Larger lifecycle/supervisor surface and its own goal/list/loop state. README recommends optional `pi-subagents` for full parallel orchestration. It includes configurable ordered model fallback, which must be disabled or fenced to honor Matthew's no-silent-PAYG rule. AGPL is a material adoption choice. No Windows GUI trial has been run.                                                                                  |

The npm registry is authoritative for the published GLLA version: its README explicitly says GitHub main may be unreleased. No package code was copied or installed into Matthew's normal Pi profile during this audit.

## Ownership and reuse decision

Studio owns the master specification and revision, milestones and dependencies, worker assignments, evidence, Lucy review identity, correction impact, continuation limit, and pause/resume/stop state. Pi GUI's native thread/worktree APIs remain the execution substrate. Native Pi session records are execution evidence, not a second task database.

Neither candidate cleanly replaces Studio. Both supervise a conversational Pi goal; neither owns Lucy's exact-commit GitHub review lifecycle, stacked milestone dependencies, correction reconciliation, or Studio's desktop control surface. Installing either now would add another continuation driver beside the Studio coordinator and Pi GUI's native child-session supervisor.

Borrow these design patterns only; no upstream code is vendored:

- **pi-goal-x:** explicit completion contracts; specification revisioning; evidence-bound independent audit; finite run allowance on each start/resume. Never inherit its unlimited-when-unset allowance.
- **GLLA:** explicit queued/running/paused/recovering/auditing states; bounded retry reasons; raw evidence per verification item; visible continuation/decision gates. Do not adopt its second supervisor, global fallback chain, or optional agent manager.

This is a research/architecture decision, not a runtime compatibility claim. On Windows, Pi's `DefaultResourceLoader` loaded the local pi-goal-x 0.31.9 extension entry from the disposable project with no resource errors. A follow-on installed-GUI attempt selected `qwen-token-plan/qwen3.8-max`, but the session record remained at metadata only: no user or assistant turn was recorded within 120 seconds. GUI command execution and model response are therefore still unverified in that trial; no further provider retries were made. GLLA is not being installed or trialed unless later evidence shows a concrete Studio gap it uniquely solves.

## Future trial acceptance checks

Run pi-goal-x only in a disposable project/profile, with an explicit small `maxAutonomousRuns` and Qwen Token Plan route. Verify extension load, commands, durable state, pause/resume, auditor execution, Windows PowerShell compatibility, restart behavior, and whether the UI degrades cleanly. Do not enable any paid fallback. Remove only the isolated test state after preserving its evidence.

## Sources

- [Pi GUI v1.0.1 orchestration runtime](https://github.com/minghinmatthewlam/pi-gui/blob/v1.0.1/apps/desktop/electron/orchestration/orchestration-runtime.ts)
- [Pi GUI v1.0.1 Pi SDK driver](https://github.com/minghinmatthewlam/pi-gui/tree/v1.0.1/packages/pi-sdk-driver)
- [pi-goal-x README/source](https://github.com/tmonk/pi-goal-x), [published package](https://www.npmjs.com/package/pi-goal-x)
- [GLLA README/source](https://github.com/DraconDev/pi-goal-list-loop-audit), [published package](https://www.npmjs.com/package/pi-goal-list-loop-audit)
