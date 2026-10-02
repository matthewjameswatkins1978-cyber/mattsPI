# Pi-free cost-boundary audit

**Checked:** 29 September 2026
**Installed package:** `pi-free` 2.8.4, MIT
**Decision:** Preserve the existing extension. It is not yet approved for automatic worker dispatch.

## Observed local state

- The installed Pi GUI profile's extension loader resolves `pi-free` from `C:\Users\Matmus\AppData\Roaming\npm\node_modules\pi-free\dist\index.js`.
- `C:\Users\Matmus\.pi\free.json` has `free_only=true` and `auto_fallback=false`.
- Fallback restoration is `manual`; fallback notifications are configured as `toast`.
- Paid-catalog visibility switches for OpenRouter, OpenCode, OpenCode Go and Qoder are off.
- Pi's saved default remains `qwen-token-plan/qwen3.8-flash` at medium thinking. A real response on the subscription provider was verified in the installed GUI, despite pi-free's free-only filter.
- Credential values were not read or displayed in this audit. Provider-key presence in a config file would not prove account entitlement, free quota, or zero-cost inference.

## Capability and boundaries

Upstream describes pi-free as a Pi extension that registers free, freemium and paid providers, filters free models by default, and can switch to other eligible free models after an error. That automatic switching is explicitly opt-in upstream. The actual local config currently keeps it off, so a failed Qwen Token Plan request does not silently move to another provider through pi-free.

The package is already part of Matthew's Pi profile; this audit did not install, update or modify it. The loader and separate Qwen GUI smoke establish that the extension can coexist with the observed Qwen subscription route. They do not prove every extension command, free-provider login, Windows-specific fallback path, or the zero-charge status of any listed model.

## Decision for Studio

- Keep `pi-free` installed and keep its automatic fallback disabled.
- Treat its filtered catalog as candidate discovery only. Do not assign a model to the automatic free worker pool until the exact provider, model, quota/entitlement, and applicable rate are verified from that provider's current terms and a real authenticated route.
- Keep subscription routes such as Qwen Token Plan independently selectable. Do not infer a free entitlement from the presence of a free-only filter.
- Keep metered profiles explicit and separate. No metered endpoint was called or changed during this audit.

## Sources

- [pi-free upstream README](https://github.com/apmantza/pi-free): provider types, free-only catalog behavior, and opt-in fallback semantics.
- [pi-free npm package](https://www.npmjs.com/package/pi-free): published package identity/version/licence.
- Local profile files inspected by safe fields only: `C:\Users\Matmus\.pi\free.json`, `C:\Users\Matmus\.pi\agent\settings.json`.
