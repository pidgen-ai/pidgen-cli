# Worker policy

Worker policy controls how coding agents run on your machine. Capacity, enabled harnesses and
provider subscriptions belong in `node.yaml`; model selection for work belongs in Pidgen.
The policy cannot enable a harness whose session cap is zero.

This reference covers the public [pidgen-worker 2.11.1 release](https://pypi.org/project/pidgen-worker/2.11.1/),
using its packaged `worker-policy.schema.json` and annotated `worker-policy.example.yaml`.
The values below are the **shipped example values**, not a promise that omitted fields have
JSON Schema defaults. Existing installations retain their configuration. Check your version with
`pidgen worker status --format json` (`data.update.installed`) and use the schema and example
shipped with that version when they differ. This reference does not pin or install a worker.

## Location and structure

The worker reads `PIDGEN_WORKER_POLICY` when set; otherwise it reads
`$PIDGEN_HOME/config/worker-policy.yaml`, with `~/.pidgen` as the default worker home.
Check the environment of the service or container that actually runs the worker.

The top-level keys are `harnesses` and `git_credentials`. Harness settings are nested under
`harnesses.pi`, `harnesses.claude`, or `harnesses.codex`. Unknown keys are refused, including
unknown keys inside those blocks. All integer bounds below are inclusive. The worker also
checks runtime requirements, such as whether a selected executable exists.

## Pi options

Keys in this table are relative to `harnesses.pi`.

| Key | Type and allowed values | Shipped example / meaning |
|---|---|---|
| `cli_path` | Absolute executable path, or `null` | Omitted: use the `pi` launcher on the worker's `PATH`; a relative path or JavaScript entry point is not a launcher |
| `compaction.enabled` | Boolean | `true` |
| `compaction.reserve_tokens` | Integer ≥ 1 | `65536` |
| `compaction.keep_recent_tokens` | Integer ≥ 1 | `20000` |
| `compaction.trigger_margin_tokens` | Integer ≥ 0 | `4096` |
| `compaction.timeout_seconds` | Integer 1–3600 | `900` |
| `vision.fallback_provider` | Nonempty string or `null` | `null`: no configured fallback provider |
| `vision.fallback_model` | Nonempty string or `null` | `null`: no configured fallback model |

Compaction settings govern Pi's context management. Pi verifies the selected model's declared
input capabilities. Configure the provider and model together for an image-capable fallback;
without a usable image model, image-bearing input fails before provider work.

## Claude options

Keys in this table are relative to `harnesses.claude`. Shared output and timeout limits are
listed [below](#output-and-timeout-limits).

| Key | Type and allowed values | Shipped example / meaning |
|---|---|---|
| `cli_path` | Absolute executable path, or `null` | Omitted: use the CLI bundled with the SDK; see [Use a newer Claude executable](worker-models.md#use-a-newer-claude-executable) |
| `allowed_setting_sources` | Unique array containing `project`, `user`, or `local` | `[]`: no setting source is permitted |
| `permission_mode` | `dontAsk`, `bypassPermissions`, or `acceptEdits` | `dontAsk`: denies tool use that is not pre-approved |
| `environment_allowlist` | Unique array of nonempty variable names | `[]`: no additional variables beyond the worker's base environment |
| `max_stream_message_bytes` | Integer 1048576–268435456 | `16777216` (16 MiB): largest single SDK stream message |
| `vision.model_modalities` | Map of model ID to an array of nonempty modality strings | `{}`: retain the worker's known models; entries add or override that model's capabilities |
| `vision.fallback_model` | Nonempty model ID or `null` | `null`: retain the shipped fallback; an explicit fallback must accept images in the merged table |

Setting sources can introduce user or project configuration, and permission modes change what
tools may do. Select them deliberately for your workload. `bypassPermissions` is not a general
fix for startup or model failures. Keep the existing permission mode when changing an unrelated
option.

For example, when using a provider integration that needs `CLAUDE_CODE_USE_BEDROCK` and
`AWS_PROFILE`, add those names to the existing allowlist:

```yaml
harnesses:
  claude:
    environment_allowlist:
      - CLAUDE_CODE_USE_BEDROCK
      - AWS_PROFILE
```

Merge the names with existing entries. Set their values in the worker's environment using that
integration's official instructions. Do not put credentials in this file. Variables controlling
the worker itself are not permitted in a harness environment. See the worker's
[agent environment guide](https://docs.pidgen.ai/worker/coding-agents/#the-agents-environment)
for variables already passed through; exporting a variable in your shell does not necessarily
make it available to a service or to the harness.

## Codex options

Keys in this table are relative to `harnesses.codex`. Codex does not have a `cli_path` key here.

| Key | Type and allowed values | Shipped example / meaning |
|---|---|---|
| `allow_explicit_binary_path` | Boolean | `false`: use the SDK's selected runtime |
| `allowed_binary_roots` | Unique array of nonempty strings | `[]`: no allowed override roots |
| `isolated_config_root` | Nonempty path string or `null` | `null`: use the worker-managed Codex home; an ambient interactive Codex home is refused |
| `allow_network` | Boolean | `true`: worker policy permits sandbox network access; the work's policy must permit it too |
| `approval_policy` | `untrusted`, `on-failure`, or `never` | `untrusted` |
| `vision.model_modalities` | Map of model ID to an array of nonempty modality strings | `{}`: retain the worker's known models; entries add or override capabilities |
| `vision.fallback_model` | Nonempty model ID or `null` | `null`: retain the shipped fallback; an explicit fallback must accept images in the merged table |

The binary controls govern permission to use an override; they do not specify an executable by
themselves. This schema has no path-selection key for Codex. Do not invent one or assume that
updating the shell's Codex executable changes the worker's selected runtime. Use a supported
worker update or obtain the documented override procedure before choosing another runtime.

Keep the worker-managed home separate from interactive sessions. Changing network or approval
policy affects the agent's execution permissions, not model availability or provider quota.

## Output and timeout limits

These keys exist separately under both `harnesses.claude` and `harnesses.codex`.

| Key | Type and allowed values | Shipped example |
|---|---|---|
| `max_output_chars` | Integer ≥ 1 | `1000000` |
| `first_event_timeout_seconds` | Integer ≥ 1 | `60` |
| `shutdown_timeout_seconds` | Integer ≥ 1 | `10` |
| `max_event_text_chars` | Integer 1–4000 | `500` |
| `max_prose_event_chars` | Integer 1–100000 | `20000` |
| `max_tool_name_chars` | Integer 1–255 | `100` |

These bound accumulated output, waiting for the first event, cleanup, and text in emitted events.
They do not change the model's context window. Codex tool-output limits are separate and have no
policy key in this schema.

## Other policy keys

`harnesses.test.allow` is a boolean, shipped as `false`, for development scenarios. It is not
a way to enable a production provider; leave it off for ordinary worker setup.

`git_credentials` is an array of at most 200 entries, shipped as `[]`. Each entry requires
`remote_url_prefix` (a string of 1–2000 characters without credentials in the URL) and `credential`
(an environment reference of the form `env:NAME`, not a token). An optional `username` is a string
of 1–200 characters. Use a valid environment name beginning with a letter or underscore and
containing only letters, digits and underscores. See
[Repository access](https://docs.pidgen.ai/worker/repository-access/) for transport setup and
matching behavior. Provider subscriptions use `node.yaml`, not this table.

## Change and verify policy

1. Identify the worker's actual policy file and version. Read the existing settings and retain
   the prior values of the keys you will change. Merge the smallest edit; the snippets above are
   partial examples, not replacement files.
2. Run `pidgen worker doctor --format json` in the worker's environment. Fix any invalid key,
   type or runtime requirement before restarting. On failure, the report is in `error.details`.
   Restore only your edit if needed, preserving any changes someone else made.
3. For harness-policy changes, restart through the method that already manages this worker so
   new processes load the configuration. For a CLI-managed detached worker or container, use
   `pidgen worker restart --format json`. Older CLIs without restart require their documented
   stop/start sequence with the original arguments. For a service, use its service manager;
   see [Run as a service](https://docs.pidgen.ai/worker/run-as-a-service/).
4. Repeat doctor and status, check connection when available, and verify the requested behavior
   on authorized work. A valid file alone does not prove that a model or integration works.

`pidgen-worker capacity reload` applies `node.yaml`; it is not a general policy reload command.
Capacity changes apply without a restart and expose saved/applied digests through
`pidgen-worker capacity show`. Harness-policy edits do not have that same readback contract.
Do not force a restart to bypass a timeout without reviewing its effect on running work.
