# Failure projection fixtures

The App Service's failure projection (ADR-169 Decision 4) as it appears on a
ticket detail's `workflow_attention.failure` and on a failed node's `failure`: `code`, `reason`
(null when none), `title`, `explanation`, `fix`, `actor` (`pidgen`, `credential_owner`,
`repository_admin`, `worker_operator` or `the_work`), `retry_class` (`transient`, `needs_fix` or
`rework`), `recommended_action` (a ticket action kind or null), `docs_anchor` and `technical`
(`{operation, exit_status, reason, excerpt}` or null). It is not yet in `contracts/openapi.json`,
so tests build against these files instead of a running App Service.

- `workflow-attention-push-protected.json` — a ticket detail's `workflow_attention` whose delivery
  push a protected branch refused, with its masked git excerpt under `failure.technical`.
