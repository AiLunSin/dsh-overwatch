# Security notes

`dsh-overwatch` runs inside the DeepSeek Harness Host process. In v0.1.0 it does
not add a listening port: it registers routes on the Host's loopback Web server
and talks only to local upstreams.

## Surfaces

- `/overwatch/api/*` is loopback-only. Browser writes are same-origin and every
  write requires `http.token`; an empty token disables writes entirely.
- The watch officer is a child agent whose tool table is restricted synchronously
  in the serial `agent/created` listener to `watch_case`, `watch_evidence` and
  `watch_decide`. It cannot call filesystem, shell, merge, swarm or subagent
  tools. Its output is an enumerated decision; policy and the executor validate,
  authorize, execute and verify it.
- The watch log under `$DSH_HOME/overwatch` (or `storage.dataDir`) records
  judgments, actions and verification results. Payloads are scrubbed for common
  secrets and bounded to 16 KB; prompts, tool argument bodies, upstream payloads
  and credentials are never written.
- The Host fish view is read-only: checkpoint index lines, manifests and audit
  tails. It never reads fishkeeper blobs or diary content.
- A fishkeeper restore runs in the browser against fishkeeper's authenticated
  connection. Overwatch records only intent/result; any request carrying a
  `confirmToken` is rejected (`RESTORE_TOKEN_REJECTED`) and the token is never
  stored, rendered, logged or placed in a URL.
- Watch evidence and case titles are untrusted data. They are delivered in a
  bounded `EVIDENCE`-style payload, never used as tool parameters or executable
  text.

## Reporting

Open a private security advisory in the repository rather than a public issue.
Include the DSH version, the plugin version, a minimal reproduction, and the
impact. No secrets or session content are required.
