# DSH Isolated

![A little blue whale uses a terminal inside a shipping container, while a laptop shows the same desktop beside the chat.](docs/repo-header.png)

Give a DeepSeek Harness conversation its own Linux desktop. Your agent can run shell commands, use Chrome and interact with the desktop inside a Docker container. Open **VM desktop** alongside the chat to see the same screen.

## Why this project

Agent tools that run on your host work directly against your machine: a mistaken command, a prompt-injected instruction or a buggy script can touch files and settings well outside the project you opened. Locking the agent down entirely solves that, but then it loses the ability to do real work — build, run tests, browse documentation, debug a web page.

DSH Isolated is an easy way to get both: keep your host isolated while still giving the agent a full environment. The agent works inside a Docker container with a complete Linux desktop, shell and browser, and you watch or steer it from the **VM desktop** panel.

**We recommend running DeepSeek Harness in read-only mode on your host.** In that setup, the isolation of your machine is provided only by the Harness sandbox: the plugin itself does not add any additional layer of host protection. The container is a comfortable working environment for the agent, not a security boundary for your host. Treat it accordingly — review what the agent does, and rely on the read-only Harness sandbox to keep your files safe.

## Install

You’ll need **DeepSeek Harness 0.2.2-rc.5**, a running Docker engine and a compatible Wrapvm desktop image on the machine that runs Harness. The plugin looks for `wrapvm-dsh:desktop` by default. If your local image uses another tag, set `agentImage` to that tag in the plugin configuration.

1. Download the [plugin bundle](https://github.com/Alexintosh/dsh-isolated/raw/refs/heads/main/dist/deepseek-ai-dsh-wrapvm-isolate-0.3.2.tgz). Keep the file as a `.tgz`. A [SHA-256 checksum](https://github.com/Alexintosh/dsh-isolated/raw/refs/heads/main/dist/deepseek-ai-dsh-wrapvm-isolate-0.3.2.tgz.sha256) is available for verification.
2. In Harness, open **Plugins → Add plugin**, choose the downloaded archive and enable **Wrapvm desktop**. If Harness asks to restart, let it finish before opening a conversation.
3. Open a conversation attached to a small project and send the prompt below.

> Prepare a VM for this project. Use the guest shell to show the current directory and list the project files.

The agent calls `vm_prepare`, starts or resumes a container, and selects it for the conversation. With the default settings, it copies the project's working files into the guest. Seeing your filenames in the reply confirms that the guest shell can read the copy. Open **VM desktop** in the conversation sidebar to see the desktop, or select **Open in host browser** to open it in a separate window.

## Try a small edit

> In the guest workspace, create a file called vm-check.txt containing “Hello from the VM”. Export it so I can review it on my machine.

Look in your project's `.wrapvm-exports/review-*` directory for the exported file. You decide which changes to bring back into the project. A named Docker volume keeps the guest workspace when you stop the environment. Open **VM environments** to start it again, see resource usage or change its CPU and memory limits.

## What gets shared?

- **Project files.** The default copy includes eligible uncommitted and untracked files. It skips Git history, dependencies, common credential files and symlinks. Review projects that contain sensitive material under other names. Each copy is limited to 5,000 files, 64 MiB total and 2 MiB per file.
- **Host folders.** Choose a bind mount when you want the guest to see the live project. A read-write mount allows guest edits to change host files directly. Harness requests approval for the path and access mode.
- **Tools and networking.** The plugin’s guest tools run inside the selected Docker container. Ordinary Harness tools still run with their host permissions. The desktop backend requires internet access. Viewer links grant access to the desktop, so keep them private.

With Harness in read-only mode, those host permissions are reduced to reading, which is what makes the setup safe: the guest container gives the agent room to work, and the Harness sandbox keeps the host unchanged.

## If something goes wrong

| What you see | What to check |
| --- | --- |
| Docker is unavailable | Run `docker info` on the Harness host. Start the engine and retry the original prompt. |
| The desktop image is missing | Run `docker image inspect wrapvm-dsh:desktop`, or substitute your configured tag. Install a compatible image locally before retrying. |
| The project exceeds the copy limit | Open a smaller project directory in Harness and ask the agent to prepare it. |
| The browser window doesn’t open | Click **Open authenticated link** in the viewer, or keep using the embedded desktop. |

For the full list of agent tools and configuration options, see the [plugin reference](docs/PACKAGE.md). To build the plugin or run its tests, see the [development guide](docs/DEVELOPMENT.md). This project uses [Wrapvm](https://github.com/tobi/wrapvm) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
