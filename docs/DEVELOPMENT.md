# Development and validation

## Standalone repository

The source and release artifacts live here. Harness core, installed packages and user profiles must not be modified to develop the plugin.

Use Node 25 and an existing compatible Harness 0.2.2-rc.5 checkout with its dependencies prepared (host and client library projects built). Set `DSH_WORKSPACE` to that checkout. This repository's `node_modules` must resolve the same development dependencies (local links to that checkout are sufficient); `link-dev.mjs` creates local links without replacing existing entries. The scripts do not install dependencies.

```sh
export DSH_WORKSPACE=/absolute/path/to/deepseek-harness
node scripts/link-dev.mjs
node scripts/dev.mjs check
node scripts/generate-remote.mjs
node scripts/dev.mjs build
node scripts/dev.mjs test tests/preparation.spec.ts tests/workspace-copy.spec.ts \
  tests/generated-read-face.spec.ts tests/v02-client.client.spec.tsx
node scripts/pack-release.mjs
```

`dev.mjs` generates local configurations in ignored `.dev/`, translates legacy test imports and runs package-only TypeScript/Vitest/tsdown. References use the already-built DSH dependencies; no reference project is rebuilt. `generate-remote.mjs` analyzes a private source snapshot under `.dev/` and writes only this bundle's Remote artifacts. `pack-release.mjs` stages the built package, resolves workspace versions and packs with lifecycle scripts disabled. It writes the archive and SHA-256 to `dist/`; it does not install it.

The optional isolated Docker check creates its own memory inventory and temporary project. It exercises automatic prepare, copy, binding, retry, pause/resume, stop/start, import/export and Chrome, and removes only resources labelled with IDs from its own inventory:

```sh
WRAPVM_LIVE_ACCEPTANCE=1 node scripts/dev.mjs test tests/agent-autonomy.live.spec.ts
```

Run the installed-runtime import smoke with the desktop app's Electron binary in Node mode and `tests/installed-runtime-loader.mjs`. It reads installed dependencies without installing, restarting or altering the running app. This validates import compatibility, not an assembled GUI or full provider lifecycle.

## Active compilation and older experiments

`tsconfig.host.json` lists the active host roots; the client roots are in `tsconfig.client.json`. Earlier protected-mode prototypes remain in source, including activation/admission/grant/policy/projection, core-fence, host-contributors, guest-shell, session-metadata, binding-session and vm-command. They are **not imported by the shipped host**, and related historical tests require abandoned core changes. `loader-composition.spec.ts` likewise targets the retired single-container API and is not the current integration suite. Use `generated-read-face.spec.ts` and `agent-autonomy.live.spec.ts` for the shipped interface.

There is no protected slash command, host-tool disabling, global binding authority or complete network isolation. No core patch is part of this release.

## 0.3.0 validation

See [the automatic-workflow release notes](RELEASE-0.3.0.md) and [the external-browser update](RELEASE-0.3.1.md) for the exact final verification results. The installed desktop remains on its previous version. GUI component tests and generated Gateway checks are separate from inspection of the assembled app, which is deliberately deferred until installation is requested.
