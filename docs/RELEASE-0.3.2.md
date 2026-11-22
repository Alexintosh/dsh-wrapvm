# 0.3.2 — DeepSeek Harness 0.2.2-rc.5 compatibility

Retargets the bundle from Harness 0.2.2-rc.2 to the released 0.2.2-rc.5 npm artifacts. No shipped behavior changes: the host service, client panel, guest tools and Remote descriptors are unchanged.

## Compatibility findings

Diffing the exact rc.2 and rc.5 release tarballs of every package the bundle imports shows only three code changes, all additive: `@deepseek-ai/dsh-llm` adds the `CONTENT_REFUSED` error code, `@deepseek-ai/dsh-client-ui-sidebar` adds the `sidebar.session.action` slot, and `@deepseek-ai/dsh-client-ui-primitives` adds an icon. `@deepseek-ai/cordis` stays 4.1.0 and every other imported package changes version metadata only, so no shipped repair was required.

`scripts/generate-remote.mjs` now injects this bundle into the staged workspace's host and client aggregate tsconfigs before analysis. The standalone generator previously depended on a DSH checkout that already referenced the plugin; it now works against any prepared checkout and reproduces the committed Remote artifacts byte-for-byte.

## Verification

- Package-only host/client TypeScript check, build and the active test suite (15 files, 276 tests) pass against the rc.5 source checkout (upstream tag `dsh-v0.2.2-rc.5`, commit `9c2670d3bce5275e0d1610272958121af87787bb`) with its libraries built.
- The rc.5 desktop plugin manager installed the 0.3.2 tarball over 0.3.1. The packed host service and generated Remote module imported successfully under the desktop runtime. Interactive desktop verification is pending.
