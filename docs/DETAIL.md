# Wrapvm desktop

Manage Docker desktop environments from **VM environments**, and select an environment from the conversation’s **VM desktop** panel. Settings exposes the same conversation selector and ephemeral desktop viewer.

The 0.2.2 interface uses native Harness controls and theme tokens. Creation, resource limits and removal have dedicated dialogs. CPU is entered in cores and memory in GiB. Optional shared folders are grouped separately, and removing an environment lets you choose whether to retain its workspace volume.

The viewer URL is owner-only and held for the active frame. It is discarded on session or selection changes, stream loss, or explicit closure; client closure does not establish server-side credential revocation.

Ordinary Harness tools retain their existing permissions. A Docker container is not a dedicated virtual machine, and offline environment creation is currently unsupported. See the [README](../README.md) for installation and boundaries.
