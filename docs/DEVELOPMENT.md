# Development and validation

## Source layout

This repository publishes the plugin source for version 0.2.2. Its build configuration and relative test imports expect the DeepSeek Harness workspace layout, with this package at `packages/bundle/wrapvm-isolate/`. Workspace dependencies are intentional; running `npm install` at this standalone checkout is not a supported build or installation workflow.

Use a compatible Harness 0.2.2-rc.2 development checkout and its documented dependency/bootstrap workflow. Copy the plugin package into the path above. Use that workspace's TypeScript, Typert generation and tsdown tooling. `tsconfig.host.json` identifies the active host compilation roots, and `tsconfig.client.json` identifies the client. Typert metadata must be regenerated when the Remote contract changes. This repository does not vendor Harness, its dependency lockfile, its core source or any core patches.

For an already prepared workspace, the client checks used for the 0.2.2 UI update (run from the Harness root) were:

```sh
node node_modules/typescript/bin/tsc -p packages/bundle/wrapvm-isolate/tsconfig.client.json
./node_modules/.bin/vitest run \
  packages/bundle/wrapvm-isolate/tests/v02-client.client.spec.tsx \
  packages/bundle/wrapvm-isolate/tests/panel.client.spec.tsx \
  packages/bundle/wrapvm-isolate/tests/registration.client.spec.ts
cd packages/bundle/wrapvm-isolate
../../../node_modules/.bin/tsdown --config tsdown.config.ts --env.DSH_BUILD_FACE client
node scripts/pack-release.mjs
```

The packaging script expects the workspace toolchain and previously built host/Remote artifacts; it does not build the whole package. It converts workspace dependency references to the target release in a staging directory. The checked-in `lib/` files come from the verified release archive. Install `dist/*.tgz`, not this source directory.

## Retained prototypes

All plugin-local source is preserved, including earlier protected-mode experiments that are **not wired into the shipped host**. These include activation/admission/capability/grant/policy/projection helpers, core-fence, host-contributors, guest-shell, session-metadata, session-events, binding-session and vm-command. Their related tests describe experimental contracts and may require unreleased core APIs; they are not a supported stock-Harness test suite or evidence of protection. The active host roots and actual imports are the authority for shipped behavior. There is no protected `/use-vm` command, host-tool disabling, durable global binding authority, or complete network isolation in this release.

## Validation recorded for 0.2.2

- 16 focused client tests passed; scoped client TypeScript and lint passed.
- Client bundle built and the 0.2.2 archive installed and enabled in Harness 0.2.2-rc.2.
- In the desktop app: empty inventory, resource card, long name, creation, limits dialog, Escape/focus return, selection, assignment, embedded viewer, removal and the volume-choice preview were checked.
- The disposable test container and volume were removed. Existing user containers were retained.
- Light theme and narrow whole-window visual checks were not performed; the conversation sidebar was visually checked.

Live test files can create Docker resources. Read their opt-in flags and cleanup logic before running them. The installed-runtime smoke targets the macOS application path and expects the package's workspace location. Historical generated test fixtures are retained for reproducibility; they are not the installed entry point.
