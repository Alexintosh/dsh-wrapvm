---
description: "Managed Wrapvm desktop environments and guest tools."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wrapvm-isolate

This optional bundle adds managed Docker environments, a conversation-specific desktop viewer and `vm_status`, `vm_shell`, `vm_browser`, `vm_desktop`, and `load_vm_skill`. It targets DeepSeek Harness 0.2.2-rc.2 and Node 24.9 or later.

Create environments from the Environments page. Each has a named persistent workspace volume at `/home/user/workspace`; additional host directories are mounted only when explicitly specified during creation. Stop preserves the container and volume. Removal requires a preview and an explicit choice whether to delete the volume; host directories are never deleted. Docker supports CPU and memory limits; disk quotas are rejected when unsupported. Select an environment in the conversation desktop panel before using the VM tools or viewer. Selection and inventory are persisted by the plugin. Viewer credentials are returned only to the owner and are excluded from `vm_status`.

The guest tools target the selected captured container. They do not redirect or disable ordinary Harness tools, and do not establish host-wide isolation. The image must provide `/opt/wrap/bin/wrap-entrypoint`, Chrome CDP, and `wrap-desktop`. Viewer and CDP ports bind to loopback. Live image startup and browser embedding depend on the local Docker installation and need verification in the deployment. Existing unrelated containers are not automatically imported or modified. Cancellation of a host command cannot guarantee immediate guest termination.

The bundle patch sets the Docker executable and resource sampling cadence; environment-specific image, limits, networking and mounts are selected at creation. The six `load_vm_skill` guidance texts describe the guest tools and recovery. No `/use-vm` command or protected-mode claim is supplied.

The Environments page uses Harness controls and theme colors. Create environments in the New environment dialog; enter CPU in cores and memory in GiB. Each environment has its own limits dialog, initialized from its current allocation. Optional host folders are grouped separately. Settings and the conversation sidebar share the same desktop selector and ephemeral viewer.
