# Persistent Pi entry — 2026-10-25

Validated against the locally installed Pi **1.4.0** on macOS arm64, using its
bundled official package, extension, CLI, and RPC documentation. Pi's local-file
install registers the source without copying it. The extension build retains
external `@earendil-works/pi-tui` root imports so Pi supplies its host classes.

The isolated smoke used a fresh `PI_CODING_AGENT_DIR`, Hikaro home, and workspace;
no real account or model was used. It passed:

- Version and basic `get_state` compatibility probe.
- Official `pi install` registration, then reinstall with exactly one entry.
- Automatic entry with a custom Hikaro home, without `HIKARO_HOME` in the process.
- Offline Hikaro response, `/back`, native `/hikaro default off`, and clean exit.

Focused tests cover an owned-wrapper update, preservation of unrelated settings,
refusal to replace a user file, failed installation leaving auto-open disabled,
unknown-version warnings, malformed RPC rejection, and packaged sibling CLI
resolution. No Pi settings are edited directly by Hikaro.

Run `pnpm test:pi` after building a final candidate. The smoke changes temporary
profiles only. Future Pi versions receive a visible warning and a basic contract
probe; this is not a claim of complete compatibility. After moving or upgrading
Hikaro, rerun `hikaro --install-pi` with the same home to update the registered
entry's module path.
