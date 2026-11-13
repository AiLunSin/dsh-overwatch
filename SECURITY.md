# Security notes

`dsh-overwatch` runs inside the DeepSeek Harness Host process and has no
network egress of its own in v0.1.0.

## Surfaces

- `/overwatch/api/*` is bound to the Host's existing loopback web server. It is
  loopback-only, same-origin for browser writes, and every write requires
  `http.token` (an empty token disables writes entirely).
- The watch log is written under `$DSH_HOME/overwatch` (or `storage.dataDir`).
  It records judgments, actions and verification results, never prompts, tool
  arguments, upstream payloads, or credentials.
- The plugin never calls a model. The watch officer (M2) will run as a
  restricted child agent whose decision is validated and executed by code.

## Reporting

Open a private security advisory in the repository rather than a public issue.
Include the DSH version, the plugin version, a minimal reproduction, and the
impact. No secrets or session content are required.
