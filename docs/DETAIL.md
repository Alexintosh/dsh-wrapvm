# Wrapvm desktop

Ask the agent to load `use-vm` and call `vm_prepare`. It prepares the conversation’s project, creates or resumes a desktop environment and assigns it automatically. No manual environment form or sidebar selection is required.

The default workspace is a persistent copy. Retries preserve guest edits. `vm_workspace` reports its mode/path, imports individual files without overwriting guest changes, and exports files into a new host review directory with conflict information. Direct host mounts require explicit native approval.

**VM environments**, Settings and the conversation’s **VM desktop** panel retain the Harness-native controls and theme. Agent selections update the open panel; **Open in host browser** opens an authenticated link in the host’s default browser; the embedded viewer remains available. Both open only on request. Its token is discarded on session/selection changes, stream loss or closure; client closure does not establish server-side token revocation.

Ordinary Harness tools retain their permissions. A Docker container is not a dedicated VM; offline creation remains unsupported. See the README for configuration and boundaries.
