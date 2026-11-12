# dsh-wrapvm

A DeepSeek Harness plugin for working in managed Docker desktop environments. Create an environment, select it for a conversation, and give your agent a guest shell, browser, and desktop while you follow along in the viewer.

**DeepSeek Harness 0.2.2-rc.2** · **Docker** · **Bundle 0.2.2**

- Create, start, stop, pause, resume, and remove managed environments from the UI.
- Select an environment per conversation and open its desktop in the right sidebar.
- Set CPU and memory limits, inspect resource statistics, and explicitly enable internet access for the current desktop backend.
- Keep work in a persistent workspace volume, with optional explicit host folder mounts.
- Give the agent purpose-built guest tools and six short guides for using them.

## Requirements

| Component | Requirement |
| --- | --- |
| DeepSeek Harness | 0.2.2-rc.2, running on the host with its plugin manager and web interface |
| Runtime | Node.js 24.9 or later for the Harness runtime; a GUI installation may provide its own runtime |
| Container engine | A working Docker installation and daemon accessible to Harness |
| Desktop image | A compatible Wrapvm desktop image with `/opt/wrap/bin/wrap-entrypoint`, Chrome CDP, and `wrap-desktop` |
| Plugin | A built `@deepseek-ai/dsh-wrapvm-isolate` 0.2.2 `.tgz` bundle available to the Harness host |

The backend has been exercised with Docker on OrbStack on arm64 using a local `wrapvm-dsh:desktop` image. The upstream image is `ghcr.io/tobi/wrapvm:desktop`; its availability and compatibility depend on your installation. On macOS, Docker runs containers through its engine VM; this plugin does not create a separate VM for each environment.

## Get started

Download the [0.2.2 bundle](dist/deepseek-ai-dsh-wrapvm-isolate-0.2.2.tgz) and its [SHA-256 checksum](dist/deepseek-ai-dsh-wrapvm-isolate-0.2.2.tgz.sha256). This is the package installed and checked in the desktop app. Install the archive, not the source directory: the source uses workspace dependencies.

1. Start Docker and DeepSeek Harness. Download the `.tgz` above and place it on the Harness host.
2. In the sidebar, open **Plugins** → **Add plugin**. Enter the absolute path to the `.tgz` in the package field, follow the installation prompts, and choose **Enable now** if offered. Restart if the manager requests it.
3. Open **VM environments** → **New environment**. Enter a name and compatible image (for example, an installed `wrapvm-dsh:desktop`), set CPU in cores and memory in GiB, and check **Allow internet**. Offline creation is not supported. Optional host mounts are under **Shared folders**; enable writing only if needed. Select **Create environment**.
4. Start the environment if it is stopped. Open a conversation, use the **VM desktop** panel in the right sidebar to select the environment, and open the desktop viewer if desired. Selection is specific to that conversation.
5. Ask the agent to use the guest tools, for example:

   > Check `vm_status`, then use `vm_shell` to list the workspace and `vm_browser` to open the app running inside the environment.

The environment must be running for shell, browser, desktop, and viewer operations. The Settings page also provides access to the conversation desktop.

## What changed in 0.2.2

The environment page, Settings and conversation sidebar now use Harness controls, theme colors and typography. Resource cards show readable units; creation, limits and removal use native dialogs. The limits dialog starts from the selected environment’s allocation.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `vm_status` | Inspect the selected environment's state, image, ports, and workspace path. |
| `vm_shell` | Run a command in a fresh guest login shell; the default working directory is `/home/user/workspace`. |
| `vm_browser` | Open and inspect pages, list tabs, navigate, evaluate JavaScript, and close tabs through guest Chrome. |
| `vm_desktop` | Run `agent-desktop` commands in the guest desktop session. |
| `load_vm_skill` | Load bundled guidance by name: `use-vm`, `vm-workspace`, `vm-browser`, `vm-desktop`, `vm-development`, or `vm-recovery`. |

`use-vm` is a guidance name for `load_vm_skill`, not a slash command.

## Workspace and lifecycle

Each environment has a named Docker volume mounted at `/home/user/workspace`. Stopping preserves the container and workspace. Removal shows a confirmation preview and lets you choose whether to delete the workspace volume. Explicit host mounts expose the paths you choose, read-only by default unless writing is enabled; removal does not delete those host directories. Existing unrelated or unlabeled containers are not automatically imported.

Environment inventory and conversation selection are persisted by the plugin. The local desktop viewer uses an ephemeral owner-only token; it is not included in `vm_status` or agent tool output.

## Configuration

The bundle defaults to the `docker` executable, a 5,000 ms resource sampling cadence, and a 15,000 ms staleness threshold. Its service configuration fields are `backend`, `metricsCadenceMs`, and `metricsStalenessMs`. Image, CPU, memory, internet access, and optional mounts are chosen when creating an environment; CPU and memory limits can also be updated from the environment page.

## Boundaries and current limitations

Harness continues to run on the host. Only the plugin's guest tools execute inside the selected container; ordinary Harness tools retain their existing permissions. Selection does not provide host-wide or complete network isolation. Disk quotas are not supported by this Docker backend. Cancelling a host-side command does not guarantee that the guest process has exited. Offline creation is rejected before allocating resources. Version 0.2.2 was installed and checked in the desktop app: creation, resource display, conversation assignment, embedded desktop and removal were exercised with a disposable environment. This is not a claim of host-wide isolation.

## Development

The current source, tests, generated runtime files and installable archive are included:

| Path | Contents |
| --- | --- |
| `src/index.ts` | Host service, Remote methods and guest tools |
| `src/client/` | Harness-native environment page, dialogs, session panel and viewer |
| `src/` | Docker backend, inventory, lifecycle and supporting modules |
| `tests/` | Unit, component, integration and opt-in live checks |
| `lib/` | Runtime files from the verified 0.2.2 archive |
| `dist/` | Installable bundle and checksum |

The source build still uses the DeepSeek Harness workspace at `packages/bundle/wrapvm-isolate/`; this checkout is **not a standalone npm build**. No Harness core patches are included or required by the installed plugin. See [development and validation notes](docs/DEVELOPMENT.md) for the build context and the distinction between shipped functionality and retained prototypes.

## Acknowledgments

Built around [Wrapvm](https://github.com/tobi/wrapvm) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose documentation covers Harness profiles and plugin management.
