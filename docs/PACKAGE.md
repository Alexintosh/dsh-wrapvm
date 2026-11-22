---
description: "Managed Wrapvm desktop environments and guest tools."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wrapvm-isolate

This optional bundle adds managed Docker environments, a conversation-specific desktop viewer and `vm_prepare`, `vm_environments`, `vm_workspace`, `vm_status`, `vm_shell`, `vm_browser`, `vm_desktop`, and `load_vm_skill`. It targets DeepSeek Harness 0.2.2-rc.5 and Node 24.9 or later.

The agent calls `vm_prepare` to create/reuse/start/resume an environment, prepare the current session project and assign it automatically. Manual creation remains available on the Environments page. Each has a named persistent workspace volume at `/home/user/workspace`; additional host directories are mounted only when explicitly specified during creation. Stop preserves the container and volume. Removal requires a preview and an explicit choice whether to delete the volume; host directories are never deleted. Docker supports CPU and memory limits; disk quotas are rejected when unsupported. No manual selection is needed after `vm_prepare`. The conversation desktop panel observes the agent selection and shows the prepared workspace; opening the viewer is optional. Selection and inventory are persisted by the plugin. Viewer credentials are returned only to the owner and are excluded from `vm_status`.

The guest tools target the selected captured container. They do not redirect or disable ordinary Harness tools, and do not establish host-wide isolation. The image must provide `/opt/wrap/bin/wrap-entrypoint`, Chrome CDP, and `wrap-desktop`. Viewer and CDP ports bind to loopback. Live image startup and browser embedding depend on the local Docker installation and need verification in the deployment. Existing unrelated containers are not automatically imported or modified. Cancellation of a host command cannot guarantee immediate guest termination.

Automatic creation uses the configured local image, CPU/RAM allocation and internet default. Missing images are reported without an implicit pull. Copy mode uses a separate persistent working tree; explicit host mounts require native approval for the exact project and mode. `vm_workspace` imports named files without overwriting different guest files and exports to a new host review directory with conflict reporting. The six `load_vm_skill` guidance texts describe the guest tools and recovery. No `/use-vm` command or protected-mode claim is supplied.

The Environments page uses Harness controls and theme colors. Create environments in the New environment dialog; enter CPU in cores and memory in GiB. Each environment has its own limits dialog, initialized from its current allocation. Optional host folders are grouped separately. Settings and the conversation sidebar share the same desktop selector and embedded viewer. Both offer **Open in host browser**, which requests an owner-only token link and hands it to the default browser. A clickable authenticated fallback handles popup blocking. Clearing the panel link does not close an external tab or revoke the viewer password.
