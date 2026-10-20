---
name: pidgen-setup-workspace
description: Make a repository's tests pass in Pidgen's isolated ticket workspaces by adding its workspace manifest — a tracked pidgen.toml with provision, activate and teardown hooks — that gives every workspace its own databases, services, ports, dependencies and settings, then rehearse the hooks locally exactly as a worker runs them before the change lands. Use when onboarding a repository to Pidgen, when tests or check commands pass on a developer machine but fail in Pidgen with connection refused, database does not exist, a missing environment variable or a missing tool, when a run fails with WORKSPACE_ACTIVATION_FAILED or a provision hook error, or when someone asks to add, fix or explain pidgen.toml. To have Pidgen inspect the repository and propose a setup, or ask its Project doctor whether the setup is why work fails, use pidgen-project-readiness; to set up the worker machine itself, use pidgen-setup-worker; to recover the failed runs afterwards, use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Set up isolated workspaces for a repository

Pidgen gives every parent ticket its own workspace: a fresh checkout of the Project's repository on
the worker machine. That isolates **files**. It does not isolate what those files talk to. So that
an agent can never reach a live system by accident, the worker builds each hook's and agent's
environment from an allowlist instead of inheriting its own. A test suite that expects a database,
a cache, a fixed port, an installed dependency directory or a variable from a developer's shell
then fails in a way that looks unrelated to Pidgen: connection refused, database does not exist,
module not found.

The fix lives in the repository, not in Pidgen. The repository declares what an isolated runtime
means for it in a tracked `pidgen.toml`, and Pidgen runs its hooks at the right moments:

| Hook | Runs | Job |
|---|---|---|
| `provision` | Once when the workspace is created, and again to repair a failed `activate` | Build this workspace's slice: start or create services, run migrations, install dependencies. May be slow. **Must be safe to re-run** |
| `activate` | Before every dispatch into the workspace: every agent turn, script and check | Report the slice as `KEY=VALUE` lines on stdout. Fast, no side effects |
| `teardown` | Before the workspace is removed | Drop what `provision` built. Idempotent, and must work on a half-built slice |

A repository without a manifest still runs, with nothing to connect to. That is deliberate: Pidgen
fails closed rather than handing an agent the machine's live configuration.

Most of this skill is work in the person's repository with its own tools. The Pidgen commands are
`pidgen project show <key> --format json` (step 1) and, to diagnose a failed run, the three run
reads in the last section. Every `pidgen` command prints one JSON envelope: read
`data`, and branch on the exit code and `error.code`.

## 1. Read the Project

```console
pidgen project show <key> --format json
```

`<key>` is the Project's ticket-key prefix or id (`pidgen project list --format json` lists them).
Two fields matter:

- `worktree_base` is the branch every new workspace is checked out from. The manifest and its
  scripts reach a workspace only once they are committed on that branch.
- `workspace_manifest` is the manifest's filename. Keep the default, `pidgen.toml`. If it reports any
  other name, stop and tell the person: workers read `activate` from the default location, so a
  manifest under another name is not run before each dispatch.

Look for a manifest in both places a worker may read one: `pidgen.toml` at the repository root, and
`.pidgen/pidgen.toml`. Newer workers read `.pidgen/pidgen.toml` first and the root file only when it
is absent; older workers read only the root file. This skill writes the root `pidgen.toml`, which
every worker reads. Keep exactly one of the two:

- If the repository has only `.pidgen/pidgen.toml` (the layout Pidgen's proposed setup uses, see
  pidgen-project-readiness), work on that file and its scripts instead of adding a root one, and
  keep its paths. Confirm with the person that their workers read `.pidgen/`.
- If it has both, the newer workers ignore the root file. Tell the person and keep one.

If a manifest exists, read it and its hook scripts first. The job is then to find why they fail,
not to replace them.

## 2. List what the tests need

Run nothing yet. Read how the tests are run today, in this order, and write down every outside
thing they depend on:

1. CI configuration (`.github/workflows/`, `.gitlab-ci.yml`, and similar): the services it starts,
   the variables it sets, and the setup steps before the test command. CI is the closest thing the
   repository has to a clean-machine recipe.
2. Compose files, dev containers and any `.env.example` or sample settings.
3. Test configuration and fixtures (`conftest.py`, `jest.config.*`, `vitest.config.*`, test
   settings modules, `testcontainers` usage) and the scripts in the build file or `package.json`.
4. The README's setup section.

Sort what you find into this table, and confirm it with the person before writing anything:

| Need | Where it goes |
|---|---|
| A service (database, cache, queue, search, object store) | One copy per workspace, built by `provision` (step 3) |
| A fixed port the tests or the app listen on | A port Docker or the OS picks, recorded by `provision` |
| An environment variable the tests read | Emitted by `activate` |
| A secret (an API key for a sandbox, a licence) | Read by `activate` from a file on the worker machine, never the repository |
| An untracked install (`node_modules`, a virtual environment, a vendored build) | `provision` runs the lockfile's install command in the checkout |
| A generated file (codegen, compiled assets, a migrated schema) | `provision` |
| A tool on the developer's `PATH` (a language runtime from a version manager, a CLI) | Installed on the worker machine, then called by absolute path or put on `PATH` by `activate` |

What the worker keeps from its own environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
locale (`LANG`, `LC_*`), `TZ`, `TERM`, `XDG_*`, toolchain roots (`PYENV_ROOT`, `NVM_DIR`,
`VIRTUAL_ENV`, `NODE_OPTIONS`, `UV_CACHE_DIR` and a few more), TLS trust bundles, proxy
variables, `SSH_AUTH_SOCK` and model-provider credentials. **Everything else is dropped**: `CI`,
`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `JAVA_HOME`, `GOPATH`, a `.env` file's contents. If a test
needs one of them, `activate` must emit it. A `.env` file is gitignored, so it does not exist in a
fresh checkout at all.

A suite with no services still fails here when it relies on an untracked install or a dropped
variable. That repository needs only `provision` (the install) and `activate` (the variables).

## 3. Choose how each service is isolated

Two workspaces of one Project run at the same time on one machine. Everything a workspace creates
must be named after that workspace, so the two never meet.

**A container per workspace (recommended).** When the services run in Docker, give each workspace
its own Compose project. Publish container ports without a host port (`ports: ["5432"]`), so Docker
picks a free one, and read it back with `docker compose port`. Nothing is shared, so nothing
collides, and `teardown` removes all of it with its volumes. The worker machine needs Docker.

**A shared server, one namespace per workspace.** When the machine already runs the service, create
one database, schema, key prefix, vhost or topic prefix per workspace, named after the workspace id.
The server's address and admin credentials are configuration of the worker machine, not of the
repository: keep them in a file under the worker user's home directory (`HOME` is kept), have
`provision` and `teardown` read it, and document in the repository's README that each worker
machine needs it. Never point a workspace at a database someone uses for anything else.

Ports: prefer letting the OS choose (port `0`) wherever the tests start a server themselves.
Otherwise use the container's published port, or have `provision` choose one and record it.

## 4. Name the workspace

The hooks receive these variables and nothing else from Pidgen:

| Variable | Meaning |
|---|---|
| `PIDGEN_WORKSPACE_PATH` | The workspace's directory on the worker. The checkout is inside it and is every hook's working directory |
| `PIDGEN_STATE_DIR` | A directory for the hooks' own records. It already exists, lasts as long as the workspace, and is deleted with it |
| `PIDGEN_CACHE_DIR` | A directory for caches, build output and bulk logs, deleted with the workspace. Nothing in it is committed |
| `PIDGEN_TICKET_ID` | The ticket that owns the workspace, when known |
| `PIDGEN_PROJECT_PREFIX` | The Project's ticket-key prefix, when known |

Derive one id from `PIDGEN_WORKSPACE_PATH` and name every resource after it. Its last path component
is already unique to the workspace. Add a short hash of the whole path so two worker users or two
machines sharing a server never collide. Put the derivation in one file that every hook sources.
Workers run on Linux and macOS, so write for the bash that ships with macOS (3.2): no `${var,,}`,
no associative arrays, and `shasum` where `sha256sum` is missing.

```bash
# scripts/pidgen/common — sourced by every hook; names this workspace's resources.
: "${PIDGEN_WORKSPACE_PATH:?run by Pidgen, or by the rehearsal in the pidgen-setup-workspace skill}"
: "${PIDGEN_STATE_DIR:?run by Pidgen, or by the rehearsal in the pidgen-setup-workspace skill}"

name="$(basename "$PIDGEN_WORKSPACE_PATH" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-')"
if command -v sha256sum >/dev/null 2>&1; then
  hash="$(printf '%s' "$PIDGEN_WORKSPACE_PATH" | sha256sum)"
else
  hash="$(printf '%s' "$PIDGEN_WORKSPACE_PATH" | shasum -a 256)"
fi
ENV_ID="${name:0:40}-${hash:0:8}"     # a Compose project name; use ${ENV_ID//-/_} for a database name
SLICE_ENV="$PIDGEN_STATE_DIR/slice.env"
COMPOSE="docker compose -p $ENV_ID -f compose.pidgen.yaml"
```

## 5. Write the manifest and the hooks

Follow the repository's own layout for scripts; the examples use `scripts/pidgen/`. The pattern:
`provision` builds the slice and writes the environment it should report to a file in
`PIDGEN_STATE_DIR`; `activate` checks that the slice still exists and prints that file. The
expensive part runs once, and `activate` stays fast and free of side effects.

```toml
# pidgen.toml — what an isolated workspace is for this repository.
[workspace]
provision = "scripts/pidgen/provision"
activate  = "scripts/pidgen/activate"
teardown  = "scripts/pidgen/teardown"

[workspace.timeouts]   # seconds; these are the defaults
provision = 900
activate  = 30
teardown  = 300
```

`[workspace]` takes only these three keys and `timeouts`. Any other key fails every dispatch, so a
misspelled hook name is caught rather than ignored. Each value is an argument list split like a
shell command line but **not run by a shell**: `scripts/pidgen/activate --fast` works,
`setup && echo done` does not. Point at a script.

```yaml
# compose.pidgen.yaml — the services the tests need, one copy per workspace.
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test
    ports: ["5432"] # no host port: Docker picks a free one
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 2s
      retries: 30
```

```bash
#!/usr/bin/env bash
# scripts/pidgen/provision — build this workspace's slice. Safe to re-run.
set -euo pipefail
. "$(dirname "$0")/common"

echo "provisioning $ENV_ID" >&2
$COMPOSE up -d --wait >&2
db_port="$($COMPOSE port db 5432)"
db_port="${db_port##*:}"

# What activate reports. Rewritten on every run, because a re-run may get a new port.
cat > "$SLICE_ENV.tmp" <<EOF
DB_PORT=$db_port
DB_NAME=postgres
NODE_ENV=test
EOF
mv "$SLICE_ENV.tmp" "$SLICE_ENV"

# The steps that need those variables see exactly what a dispatch will see.
while IFS='=' read -r key value; do export "$key=$value"; done < "$SLICE_ENV"
npm ci >&2                          # the repository's lockfile install, into the checkout
npm run db:migrate >&2              # anything else the tests expect to exist
```

Write into that heredoc every variable from step 2's table, in the form the tests read: a full
connection URL built from `$db_port`, a feature flag, a mode. Replace the two `npm` lines with the
repository's own install and setup commands.

```bash
#!/usr/bin/env bash
# scripts/pidgen/activate — report this workspace's environment. Fast; changes nothing.
set -euo pipefail
. "$(dirname "$0")/common"

# Fail only when no safe environment can be reported: provision has not run, or what it built is gone.
if [ ! -f "$SLICE_ENV" ]; then
  echo "activate: no slice for $ENV_ID; provision has not run" >&2; exit 1
fi
if [ -z "$($COMPOSE ps -q db)" ]; then
  echo "activate: the db container for $ENV_ID is not running" >&2; exit 1
fi

cat "$SLICE_ENV"

# Secrets: KEY=VALUE lines in a file on the worker machine, never in the repository or on stderr.
secrets="$HOME/.config/my-app/pidgen-test.env"
if [ -f "$secrets" ]; then cat "$secrets"; fi
```

```bash
#!/usr/bin/env bash
# scripts/pidgen/teardown — drop what provision built. Idempotent; works on a half-built slice.
set -uo pipefail
. "$(dirname "$0")/common"

$COMPOSE down -v --remove-orphans >&2 || true
rm -f "$SLICE_ENV"
```

### The rules each hook is held to

**`activate`'s stdout is a contract, and anything else fails the dispatch.** Every line is
`KEY=VALUE`, with `KEY` matching `[A-Za-z_][A-Za-z0-9_]*` and the value everything after the first
`=`, taken literally. Blank lines and `#` lines are ignored. There is no quote processing:
`FOO="bar"` gives the five characters `"bar"`, quotes included. Any log line, progress message or
tool output on stdout fails every dispatch, so send all of it to stderr (`>&2`), including the
output of commands the hook calls. What `activate` prints wins over everything the worker kept, so
it may hand back `PATH` (write out the whole value, for example `PATH=/opt/tool/bin:$PATH` with
`$PATH` expanded by the script) or a `DATABASE_URL` that points at this workspace's own database.

**`activate` fails only when it cannot report a safe environment.** Exit non-zero when the slice is
missing or a required variable cannot be produced. **Never fail on something a ticket legitimately
changes**: agents edit source, configuration, dependency manifests and lockfiles. A check such as
"the lockfile no longer matches what `provision` installed" turns a routine dependency change into
a failed ticket. To notice drift, warn on stderr and exit 0. When `activate` does fail, the worker
runs `provision` once and tries `activate` again, and fails the node only if that does not help.

**`provision` is safe to run again on a workspace it already built.** It runs on a half-built
workspace after a failure, and on a fully built one to repair `activate`. Use the idempotent form of
each step (`up -d`, `create ... if not exists`, the lockfile install that reuses what is there) and
write `$SLICE_ENV` last, atomically, as above.

**`teardown` never stops part-way.** Run each step even if an earlier one failed, treat "already
gone" as success, and expect a workspace where `provision` failed at any point. A teardown failure is
logged and the workspace is removed anyway, so whatever it fails to drop leaks.

**Every hook runs with the checkout as its working directory**, in the environment from step 2 plus
the variables from step 4, and is killed at its timeout. A slow step belongs in `provision`, whose
timeout can be raised in `[workspace.timeouts]`. `activate` has to finish well inside its own.

**The files must be tracked and executable.** A new checkout contains tracked files only, so commit
`pidgen.toml`, the scripts and any Compose file, and commit the scripts executable
(`git add --chmod=+x scripts/pidgen/*`). A hook that is missing or not executable fails with "could
not be executed".

## 6. Rehearse, as a worker runs it

Never hand over hooks that have not run. Rehearse on the machine that runs the worker, or one set up
the same way: the hooks call Docker, the toolchains and the secrets file *there*. Commit the
work on a branch first, because the rehearsal checks out that branch fresh, as Pidgen does, which
also proves every file is tracked and that nothing relies on an untracked install.

```bash
branch="$(git branch --show-current)"
root="$(mktemp -d)"

# One workspace: a directory named like Pidgen's, holding a fresh checkout of the branch.
make_workspace() {
  local ws="$root/$1"
  mkdir -p "$ws/state" "$ws/cache"
  git worktree add --detach "$ws/code" "$branch" >/dev/null
}

# Run a command in a workspace's checkout with what the worker keeps and the identity it adds.
in_workspace() {
  local name="$1" ws="$root/$1"; shift
  ( cd "$ws/code" && env -i \
      PATH="$PATH" HOME="$HOME" USER="$USER" SHELL="$SHELL" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
      PIDGEN_WORKSPACE_PATH="$ws" PIDGEN_STATE_DIR="$ws/state" PIDGEN_CACHE_DIR="$ws/cache" \
      PIDGEN_TICKET_ID="TKT-rehearsal-$name" PIDGEN_PROJECT_PREFIX="DEMO" \
      "$@" )
}

# What a dispatch sees: the same, plus activate's lines, each passed literally.
run_activated() {
  local name="$1" out line; shift
  local -a vars=()
  out="$(in_workspace "$name" scripts/pidgen/activate)" || return 1
  while IFS= read -r line; do
    case "$line" in ''|'#'*) ;; *) vars+=("$line") ;; esac
  done <<< "$out"
  in_workspace "$name" env "${vars[@]}" "$@"
}
```

Before the first hook, add the person's `PYENV_ROOT`, `NVM_DIR` or other kept variables to
`in_workspace` if their toolchain needs them, and nothing else. The point is to prove the hooks work
without the developer's environment.

Then run each check and stop at the first failure:

| # | Check | Pass when |
|---|---|---|
| 1 | `make_workspace DEMO-a`, then `in_workspace DEMO-a scripts/pidgen/provision` | Exits 0 |
| 2 | `in_workspace DEMO-a scripts/pidgen/activate` | Exits 0, and the stdout check below prints nothing |
| 3 | `run_activated DEMO-a <the test command>` | The tests pass, or fail only where they also fail on a developer machine |
| 4 | `activate` again | Same output, under a second or two |
| 5 | Edit the lockfile or a source file in `DEMO-a`'s checkout, then `activate` | Still exits 0 |
| 6 | `provision` again, then `activate` and the tests | All pass: provision is idempotent |
| 7 | `make_workspace DEMO-b`, provision it, run both workspaces' tests at the same time | Both pass; no shared container, database or port |
| 8 | Stop the service under `DEMO-a` (for example `docker stop` its container), then `activate` | Exits non-zero with a message naming the problem on stderr; then `provision` and `activate` bring it back |
| 9 | `teardown` in both, then `teardown` again in both | Exits 0 every time; `docker compose ls` (or the server) shows nothing named after either workspace |
| 10 | `make_workspace DEMO-c`, interrupt its `provision` part-way (Ctrl-C), then `teardown` | Exits 0 and leaves nothing behind |

The stdout check for check 2, which prints every line a worker would refuse:

```bash
in_workspace DEMO-a scripts/pidgen/activate 2>/dev/null | grep -vE '^[A-Za-z_][A-Za-z0-9_]*=|^#|^$'
```

Clean up afterwards: `git worktree remove --force` each checkout, then delete `$root`.

Fix and re-run until all ten pass. Report the table to the person with each result.

## 7. Land it

Open a pull request from the branch into `worktree_base`, describing the slice and listing what each
worker machine needs (Docker, a toolchain, the secrets file and its keys, never their values). Add
the same list to the repository's README. Workspaces created after the merge get the hooks.

Prove it on one new, small ticket in the Project before relying on it. A ticket whose workspace was
created before the merge was checked out without the manifest; recover it with pidgen-retry-run and,
if its runs still fail the same way, pidgen-unstick-ticket.

## Diagnose a failure in Pidgen

```console
pidgen run list <ticket> --format json
pidgen run show <run> --format json
pidgen run node-output <run> <node> --format json
```

Take the newest run's `workflow_run_id`, its `terminal_reason_code`, and the failed entry in
`nodes`. That node's `attempts` carry the `error`, which for a hook problem quotes the hook and the
end of its stderr. Make the last line a hook writes to stderr before exiting say what is wrong.

| Message or symptom | Cause and fix |
|---|---|
| Tests fail with connection refused or database does not exist, and no hook error | No manifest on the branch, a `.pidgen/pidgen.toml` on a worker that reads only the root file, or `activate` did not emit the variable the tests read. Check step 2's table against `activate`'s output |
| `WORKSPACE_ACTIVATION_FAILED` and `line N is not KEY=VALUE` | Something printed to `activate`'s stdout: a log line or a command's own output. Redirect it to stderr |
| `has an invalid key` | A line like `export FOO=bar` or `FOO-BAR=1`. Print `FOO=bar` |
| A value arrives with quotes in it | The hook quoted it. Print the bare value |
| `activate hook failed with exit code`, and `still failing after re-running the provision hook` | `activate` refuses something `provision` cannot repair. Usually a gate on a file the ticket changed: make it a stderr warning |
| `re-running the provision hook to repair it also failed` | `provision` is not safe to re-run. Make each step idempotent |
| `no [workspace] section` or `unknown key(s) in [workspace]` | The manifest's shape. Only `provision`, `activate`, `teardown` and `timeouts` |
| `could not be executed ... Is ... present and executable` | The script is missing on the branch, not executable, or its interpreter is not on the worker's `PATH` |
| `exceeded its ...s timeout` | Move slow work into `provision`, or raise its timeout |
| The run fails before its first node, naming the provision hook | `provision` failed. Its stderr is in the message; reproduce with step 6, check 1 |
| Two tickets' tests interfere | A resource is not named after the workspace id |
| A tool works in the person's shell but not in a hook | Its variable or `PATH` entry is not kept. Emit it from `activate`, or call the tool by absolute path |

Once the fix is on `worktree_base`, recover the failed tickets with pidgen-retry-run.

## Never

- Point a workspace at a database, cache or queue used by anything else, or copy a developer's
  `.env` into the hooks.
- Commit a secret, print one to stderr, or put one in the pull request.
- Print anything but `KEY=VALUE` lines, blank lines and `#` comments on `activate`'s stdout.
- Make `activate` fail because a ticket changed a file.
- Hand over hooks that have not passed step 6.
