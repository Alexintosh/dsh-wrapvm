# 0.3.0 — agent-driven VM preparation

Prepared in the standalone plugin repository. **Not installed into the active desktop profile.**

The agent can now create/reuse/start/resume a managed environment, copy the current conversation project into its persistent volume, and select it through one `vm_prepare` call. Preparation identities are persisted before engine effects; retries retain guest edits. Shell calls use the prepared guest directory by default.

New support tools expose managed environments and bounded project import/export. Direct mounts require a real native approval. Exports write new review files and report host conflicts, without overwriting originals. Missing/replaced containers and uncertain operations are not reset automatically.

The conversation panel observes tool-driven selections and displays workspace mode/path. Inventory refreshes while visible. Opening the viewer remains explicit. The six bundled guides describe the automatic workflow.

## Verification

- Package-only TypeScript host/client checks and builds passed.
- **270 tests passed in 15 active suites**, including preparation/retries, file exclusions and export conflicts, approval refusal, lifecycle/backend regressions, generated Loader/Gateway codecs and client components. Historical retired-API/protected-mode suites are documented separately in DEVELOPMENT.md and excluded from the active default suite.
- **One opt-in live acceptance passed against the built host entry** using a separate memory inventory, temporary project and disposable Docker environment: unassigned status → automatic creation/copy/selection → guest file edits → retry without overwrite → pause/resume → stop/start → targeted import conflicts → export review with host conflict → Chrome open/close. Its labelled container, network and volume were removed.
- The built host imported against the unchanged installed Harness 0.2.2-rc.2 runtime using Electron in Node mode.
- Strict NodeNext consumer declarations and scoped source lint passed.

The generated Remote face includes workspace metadata and retains existing lifecycle signatures. No DSH core patch, dependency installation, profile update, app restart or push is part of this work. The assembled GUI remains to be checked when installation is requested.

## File-transfer limits

Initial copy: 5,000 files / 64 MiB total / 2 MiB per file. Credentials matched by the documented filters, symlinks, hard links, Git metadata, dependencies and build/cache directories are excluded. These filters cannot classify every possible secret in arbitrary project files. Import/export accepts 1–100 relative file paths. Import does not overwrite differing guest files; export does not apply changes or deletions to host originals.

If source files change after an interrupted initial preparation but before publication, retry refuses to combine different snapshots. A confirmed host process exit is not a guarantee that a guest subprocess has exited. Harness itself and its ordinary tools still run on the host; this is not whole-host isolation.
