# 0.3.1 — authenticated host-browser viewer

Adds **Open in host browser** to the shared VM desktop component in the conversation panel and Settings. The embedded viewer remains available.

The action requests the existing owner-authorized viewer endpoint on click, checks its session epoch/revision, expiry and loopback token URL, then uses Harness's existing external-window behavior to open the host's default browser. No Harness patch or new Remote API is required. A real **Open authenticated link** fallback supports browsers that block asynchronous popup opening.

Links stay in component memory and disappear on selection/session changes, stream termination or reported expiry. The token is not returned to agent tools or written to application tab/settings storage. The external browser can retain history, authentication and an open tab; panel cleanup does not revoke the VM password or close that external tab. The default Wrapvm password is persistent, not a one-use or short-lived credential. Loopback URLs are intended for a browser on the Harness host.

## Verification

- 24 tests passed across the affected viewer/client/registration and generated Gateway suites.
- Tests cover explicit opening with `noopener,noreferrer`, popup fallback, stale selection responses, stream termination, malformed/nonlocal/tokenless links, and host refusal of a tokenless helper response.
- Package-only host/client TypeScript and build passed; scoped lint and whitespace checks passed.
- Built entry import against the installed stock DSH runtime passed without updating or restarting the app.

No installation, profile change, Docker mutation or live browser opening was performed. Actual native-browser opening from the assembled app remains to be checked when the update is installed.
