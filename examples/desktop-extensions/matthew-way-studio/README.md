# Matthew Way Studio extension

The user-level Studio extension provides `/studio`, `/studio start`, and `/studio models` for Pi GUI. The model selector only lists routes Pi reports as both available and authenticated. Role and model stay separate; saved model and thinking preferences apply to future delegated work, never change the current thread, and never select `xhigh` or `max` thinking.

`studio-models.json` version 1 route-only settings remain readable and retain Pi's model-default thinking behavior. The first preference save writes version 2 with a route and a model-supported thinking preference per role. `Use model default` leaves the override to Pi.

To update Matthew's existing Windows user extension, preserve the profile's other files and replace only `%USERPROFILE%\.pi\agent\extensions\matthew-way-studio\index.ts` with this `index.ts`. No credentials or profile data belong in this package. Reopen or reload the Pi session to load the updated command.

Run `pnpm test` and `pnpm typecheck` in this directory to verify preference migration, supported-level filtering, and command behavior without contacting a provider. The Electron spec `apps/desktop/tests/core/studio-role-preferences.spec.ts` verifies the visible command, saved preference, and current-thread model separation; set `PI_APP_STUDIO_TEST_EXECUTABLE` to an installed `pi-gui.exe` to run that same flow against the packaged GUI with an isolated profile and fixture credentials.
