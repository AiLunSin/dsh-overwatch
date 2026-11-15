# Security notes

`dsh-overwatch` runs inside the DeepSeek Harness Host process. In v0.1.0 it does
not add a listening port: it registers routes on the Host's loopback Web server
and talks only to local upstreams.

## Surfaces

- `/overwatch/api/*` is loopback-only and requires a loopback `Host` header.
  Browser writes are same-origin and every write requires `http.token`; an empty
  token disables writes entirely.
- The watch officer is a child agent whose tool table is restricted synchronously
  in the serial `agent/created` listener to `watch_case`, `watch_evidence` and
  `watch_decide`. If the restriction cannot be proven, the officer is failed
  closed: no card, no wake and no decision. It cannot call filesystem, shell,
  merge, swarm or subagent tools. Its output is an enumerated decision; policy
  and the executor validate, bind it to the supervised run, authorize, execute
  and verify it.
- The watch log under `$DSH_HOME/overwatch` (or `storage.dataDir`) records
  judgments, actions and verification results. Payloads and the derived case
  and snapshot views are scrubbed for common secrets and bounded; prompts, tool
  argument bodies, upstream payloads and credentials are never written.
- The Host fish view is read-only: checkpoint index lines, manifests and audit
  tails. It never reads fishkeeper blobs or diary content.
- A fishkeeper restore runs in the browser against fishkeeper's authenticated
  connection. Overwatch records only intent/result; any request carrying a
  `confirmToken` is rejected (`RESTORE_TOKEN_REJECTED`) and the token is never
  stored, rendered, logged or placed in a URL.
- Watch evidence and case titles are untrusted data. They are delivered in a
  bounded `EVIDENCE`-style payload, never used as tool parameters or executable
  text.
- `requiresHuman` decisions/plans enter a durable approval queue. Approval is
  two-step: `challenge` mints a high-entropy one-time token whose SHA-256 (bound
  to the approval id) is stored, never the plaintext; `approve` consumes it in
  constant time. Tokens expire after 5 minutes, pending records after
  `policy.approvalTtlMs`, and human approval can never bypass `observe`.
- Set `OVERWATCH_CHAIN_KEY` to authenticate the log with HMAC-SHA256. External
  anchors (`<dataDir>/anchors/<runId>.jsonl`) are appended every 64 events and
  on close; `doctor` compares them with the verified chain to expose truncation
  or rewrites. A keyless reader cannot verify an HMAC chain.
- Run directories are `0700` and files `0600`. `watch.jsonl` and lock files
  refuse symlinks, and stale-lock takeover re-reads the moved owner nonce to
  avoid a TOCTOU window.
- `storage.retentionDays` drives a periodic purge of archived, unlocked,
  chain-valid runs only; a tombstone event is written before deletion.

## Reporting

Open a private security advisory in the repository rather than a public issue.
Include the DSH version, the plugin version, a minimal reproduction, and the
impact. No secrets or session content are required.
