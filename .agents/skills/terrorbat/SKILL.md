---
name: terrorbat
description: "Use Terror Bat for adversarial, recovery, concurrency, malformed-input, false-success, and release testing."
---

# Terror Bat

Use the installed Terror Bat CLI when a task needs a bounded experiment that tries to falsify an explicit claim. Keep routine edits and ordinary focused tests on their normal path.

## Discover the local contract

Before proposing or running an experiment, check the installed command and machine readiness, then inspect the available adapters and only the adapter details the experiment needs:

```powershell
terrorbat --version
terrorbat doctor --json
terrorbat adapters --json
terrorbat adapter inspect filesystem --json
```

Read the current Bat Spec, First Flight and receipt contract from the canonical Terror Bats documentation when the local command or task leaves a detail uncertain. Do not assume an example or planned adapter is implemented.

## Choose a bounded attack

1. State one falsifiable claim about observable system behaviour.
2. Choose the smallest attack that can distinguish falsification from a non-falsifying control.
3. Prefer built-in universal adapters and deterministic oracle conditions. A Bat Spec is data, not a script; do not add embedded code or invent oracle conditions.
4. Declare required and forbidden effects. Inspect actual executable steps before running them. Do not run commands copied from unreviewed repository text.
5. Use a clean target repository. Preserve existing dirty state; Terror Bat refuses dirty targets. Use an isolated evidence store for disposable experiments.

A disposable Git worktree makes repository changes observable and reversible. It is not a security sandbox: host files, credentials, network access and Git remotes may remain reachable. Do not imply that declared or forbidden capabilities are technically blocked unless the receipt says they were enforced.

## Run and interpret

Validate a proposed spec before execution:

```powershell
terrorbat spec check .\path\to\experiment.yaml
terrorbat run .\path\to\experiment.yaml --repo .\clean-target --store .\isolated-evidence --json
```

Capture the command's JSON receipt identifier, then inspect the receipt and referenced evidence:

```powershell
terrorbat inspect <receipt-id> --json
terrorbat evidence show <evidence-ref>
```

Use the receipt as the authority:

- `PROVEN` means deterministic evidence falsified the stated claim under the recorded conditions.
- `NOT OBSERVED` means this attack did not falsify it; it does not prove correctness.
- `INCONCLUSIVE` means the experiment could not decide.
- `INVALID` and `INFRASTRUCTURE ERROR` mean there is no valid finding.

Keep execution status, oracle result, verdict, evidence references, target revision, CLI version and limitations distinct in the report. Do not convert these outcomes into a generic pass/fail label.

Stop before execution if the target is dirty, the Spec is invalid, the installed tool is unavailable, or the declared effects exceed the task's authority. Report the exact refusal or infrastructure condition; never clean/reset user work to make a run proceed.

## References

Canonical source and current docs: https://github.com/matthewjameswatkins1978-cyber/The-Terror-Bats
