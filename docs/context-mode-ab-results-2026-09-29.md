# Context-mode Pi GUI A/B: 29 September 2026

## Setup

- Runtime: installed Windows Pi GUI Matthew Way Studio build; temporary GUI profiles and workspaces.
- Provider/model: Qwen Token Plan `qwen-token-plan/qwen3.8-max` in both runs. The isolated profiles enabled only this route; no metered route was available to fall back to.
- Candidate: `npm:context-mode@1.0.169`, pinned in the test profile only. It was not added to Matthew's normal Pi profile or installed globally.
- Control: the same profile packages without context-mode.
- Task: in separate copies of `work/studio-demo`, follow the README to correct `add(2, 3)`, keep its named test, run `npm test`, and report the change. No commit or publication.

## Evidence

Both sessions used the requested Qwen route, changed only `src/math.mjs`, preserved `src/math.test.mjs`, called `npm test`, and reported success. I reran `npm test` independently in both workspaces: one test passed, zero failed in each. Session JSONL records were inspected for route, usage, tool calls, and task evidence.

| Measure                                          |             Baseline |         Context-mode |
| ------------------------------------------------ | -------------------: | -------------------: |
| Assistant model calls                            |                    6 |                    7 |
| Pi-reported input tokens                         |                3,399 |               20,366 |
| Output tokens                                    |                  696 |                  894 |
| Cached input tokens                              |               59,392 |              119,296 |
| Pi-reported total tokens (includes cached input) |               63,487 |              140,556 |
| Tool calls                                       |                    8 |                    9 |
| Tool-result text                                 |          1,604 chars |          6,460 chars |
| User-prompt-to-final-response time               |               49.5 s |               60.8 s |
| Outcome                                          | correct; test passed | correct; test passed |

Context-mode invoked `ctx_batch_execute` and `ctx_execute`, but it also used native `read`, `ls`, and `edit`. This run therefore did not demonstrate exclusive or more economical context routing. For this task, it used about 2.2 times the total reported tokens, 4 times the returned tool text, and took about 23% longer. This is a single small-task comparison; it does not establish performance on very large command output or long repository investigations.

The first pilot run did not override context-mode's default storage root. Its Pi adapter created three local database/statistics files under `C:\Users\Matmus\.pi\context-mode` at the time of the test. I moved that directory unchanged to `work/context-mode-trial-state-20260929` after confirming no active context-mode process; source and destination SHA-256 hashes matched for all three files. The normal `.pi` profile no longer contains that pilot data. The live-test harness now sets `CONTEXT_MODE_DIR` inside each temporary profile to prevent recurrence.

## Compatibility and decision

- **Pi GUI compatibility:** verified at runtime on Windows. The installed Pi GUI loaded the pinned package and the live session called its `ctx_*` tools.
- **Hook fit:** the package registers Pi session/tool hooks and injects routing and active-memory context. Its checked-in Pi adapter maps `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`; its routing blocker specifically intercepts `bash`. Matthew's native PowerShell and Threadmoth surfaces are not in that map. The model's mixed native/context-mode usage is consistent with incomplete routing for this setup.
- **Overlap:** it adds session-event capture, SQLite memory, compaction snapshots, and injected active memory. That is a separate local memory layer alongside Studio's durable run ledger and Basic Memory. It does not replace Studio's goal/checkpoint owner.
- **Cost/provider:** no extra provider was configured. Both calls used Qwen Token Plan; this comparison says nothing about quota entitlement beyond successful routing on these calls.
- **License:** npm package metadata identifies Elastic-2.0. This is source-available under its stated terms; review those terms before redistribution or modification.
- **Decision:** reject default/global adoption for Matthew's current Windows Pi workflow. Leave Pi-lean-ctx uninstalled. Reconsider only if a larger-output workload shows measured savings and routing is adapted or proven for PowerShell and Threadmoth.

## Evidence limits

One comparison task is not a general benchmark. Startup time and a realistic large-output/long-investigation task were not measured. The test harness initially had an incorrect expectation for the tool-name prefix (`context_mode_` instead of the observed `ctx_`); the exact completed GUI sessions and independent test reruns were then checked directly from their session records. No second paid or subscription model call was made to hide or repeat that result.

## Sources

- [Context-mode Pi package instructions and platform notes](https://pi.dev/packages/context-mode)
- [Context-mode source and Pi adapter](https://github.com/mksglu/context-mode)
- [Pi GUI v1.0.1 source release](https://github.com/minghinmatthewlam/pi-gui/tree/v1.0.1)
