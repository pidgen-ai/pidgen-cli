---
name: pidgen-setup-worker
description: Take a machine from nothing to a running, verified Pidgen worker with scriptable pidgen commands, then configure that worker — its prompt and script pools, each coding agent's session cap, which agents it runs, fallback provider logins and the primary one — and bring it back after a reboot. Use when someone wants to set up, enroll, start, check, resize or repair the worker on this machine, or when pidgen setup exits with TERMINAL_REQUIRED. To file work once the worker runs, use pidgen-file-ticket; to recover failed runs, use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Set up and configure a worker

A worker is the `pidgen-worker` program running on a machine the person controls. It connects out
to their Pidgen server with its own credential, claims the Account's work, and drives the coding
agents installed here (Claude Code, Codex, Pi). The CLI installs, enrolls and runs it; the worker
owns its own configuration.

`pidgen setup --format json` does this whole path, but it asks questions and so runs only on a terminal. From an
agent's shell it exits 2 with `TERMINAL_REQUIRED` and lists the same steps in
`error.details.commands`. Follow the steps below instead, which are those commands with the
decisions spelled out. Every `pidgen` command prints one JSON envelope: read `data`, and branch on
the exit code and `error.code`.

Some steps need the person, not you: approving the sign-in, accepting the worker's licence, and
logging each coding agent in. Stop and ask at those points; never approve, accept or log in on
their behalf.

## 1. Check the machine

```console
pidgen doctor --format json
```

`data.checks` is a list of `{id, status, summary, fix}`. Read every check whose `status` is `fail`
or `warn` and act on its `fix`:

| Check | What to do |
|---|---|
| `node` | Node.js is too old for the CLI; the person upgrades it |
| `server` | The server is unreachable or not Pidgen. With nothing configured this is the hosted Pidgen server; if the person uses another server, step 2 signs in to it |
| `credential` | Not signed in, or the credential may not enroll workers. Step 2 fixes it |
| `runtime` | `uv` is missing. The CLI never installs it: give the person the `fix` |
| `releases` | The server's worker release list could not be read. Nothing can be installed until it can; report the `summary` and stop |
| `harness:<kind>` | That coding agent's command is not on `PATH`. One missing beside another found is fine; all missing is a `fail`, and the person installs at least one |
| `worker` | No worker installed yet (`warn`, expected on a fresh machine), or one the server no longer accepts. Step 3 fixes it |

Exit 1 with `DOCTOR_FAILED` means at least one `fail`; the report is in `error.details`. A failing
`credential` or `worker` is fixed by the steps below, so carry on. Any other `fail` must be fixed
first.

## 2. Sign in

Skip this step when `credential` was `ok` and says the credential may enroll workers.

```console
pidgen auth login --format json
```

Without an address it signs in to the configured server, or on a fresh machine the hosted Pidgen
server. Add the address only when the person uses another server, such as
`pidgen auth login https://pidgen.example.com --format json`. The command writes a verification address and a code
to standard error and then waits. Show both to the person, ask them to open the address, enter the
code and approve, and wait for the command to finish. It exits 3 with `access_denied`,
`expired_token` or `invalid_grant` when the login is denied or the code expires; start it again if
the person wants to retry.

On success `data.account` is the Account the person chose. When they belong to several, they pick
it while approving; `pidgen account use <account> --format json` changes the default later.

Enrolling a worker needs an Account Owner or Administrator, or a Personal API Token with
`workers:enroll`. Run `pidgen doctor --format json` again: when `credential` warns that it may not enroll, the
person either asks an Owner or Administrator to enroll the machine, or creates a token with
`workers:enroll` in the web app and signs in with it. The token is read from standard input, so the
person runs this themselves; never put a token in a command line or a file:

```console
pidgen auth login --with-token --account <account> --format json
```

## 3. Install and verify the worker

Installing the worker accepts its licence, so ask first. Tell the person that `pidgen-worker` is
proprietary software under its own end-user licence agreement, that installing it accepts the
agreement, and that the command prints the notice. Install only after they agree.

```console
pidgen worker install --runtime wheel --format json
pidgen worker verify --format json
```

`wheel` is the runtime to use today; it needs `uv`. Add `--version <version>` only when the person
asks for a specific release. `data` is the install record: `version`, `digest`, `identity` (who
signed the release) and `location` (the installed `pidgen-worker`). `installed: false` means that
version was already installed, which is fine.

| Exit | `error.code` | Meaning and next step |
|---|---|---|
| 2 | `RUNTIME_UNAVAILABLE` | `uv` is missing; `error.details.install` says how to install it |
| 5 | `RELEASE_UNSUPPORTED` | The server does not accept that version; `error.details.accepted` lists those it does |
| 5 | `PROVENANCE_INVALID` | The release did not verify (`error.details.check` says what failed). Nothing was installed. Never try to get around this; report it |
| 4 | `NOT_FOUND` | The server does not publish its worker release list yet. Nothing can be installed; report it |
| 1 | `INSTALL_FAILED` | `uv tool install` failed; its output is on standard error |

`pidgen worker verify --format json` re-checks the installed worker's digest and signature; `data.checks` must all
be `ok`. A failure exits 5 with `PROVENANCE_INVALID` and its fix, `pidgen worker install --force --format json`.

## 4. Enroll and start

Pick a label: the person's choice, or this machine's host name. Enroll, then start the worker in the
background:

```console
pidgen worker enroll --label build-box-1 --no-install --format json
pidgen worker start --detach --format json
```

`--no-install` because step 3 installed it. Enrolling does not start the worker;
`pidgen worker start --detach --format json` does, and the CLI records that worker so it can stop it and report
on it.

`pidgen worker enroll --format json` creates a one-time enrollment and hands it to the worker, which exchanges it
for its own credential. The token is never printed and you never see it. `data.enrolled` is `true`
on success.

| Exit | `error.code` | Meaning and next step |
|---|---|---|
| 3 | `FORBIDDEN` | The credential may not enroll workers; go back to step 2 |
| 2 | `WORKER_NOT_FOUND` | `pidgen-worker` is not on `PATH`. Add the directory of the install record's `location` to `PATH` and enroll again |
| 1 | `ENROLL_FAILED` | The worker refused; its reason is on standard error. A host already enrolled in this Account is refused: pass a different `--host-id` after `--`, or remove the old worker in the web app. Each attempt spends one enrollment, so read the reason before retrying |

`pidgen worker start --detach --format json` waits two seconds. Exit 1 with `WORKER_EXITED` means the worker
stopped at once; read `error.details.log_tail`. Exit 5 with `WORKER_ALREADY_RUNNING` means one is
already running, which is fine.

## 5. Confirm it connected and works

```console
pidgen worker status --format json
pidgen worker doctor --format json
```

In `pidgen worker status --format json`, `data.running` must be `true`, and with an Owner or Administrator's
credential `data.server.worker.connected` turns `true` within a minute or two; run it again until it
does. `data.server` is `null` for a Personal API Token, which cannot read the Account's workers, so
there `data.running` and the doctor are the evidence. `data.update.needed` says whether a newer
release should be installed (section "Update").

`pidgen worker doctor --format json` runs the worker's own checks. `data.ok` is `true` when all pass; each entry
of `data.checks` has `name`, `ok`, `summary` and, when it fails, `defect` and `remedy`. A failure
exits 1 with `DOCTOR_FAILED` and the report in `error.details`. Typical failures and their remedies:

- **A coding agent is not logged in.** The person logs in with that agent's own command, such as
  `claude /login`. You never handle their credentials.
- **A coding agent's command is missing** while the worker is set to run it: install it, or switch
  that agent off (section "Configure the worker").
- **`git`, `node` or `npm` is missing or too old:** the person installs it.

Once the doctor passes, offer the next step: install these skills into the person's coding agents
with `pidgen skills install --format json`, then file a first ticket (see pidgen-file-ticket).

## Configure the worker

The worker keeps its configuration in `node.yaml` under its home directory (`~/.pidgen/config/`, or
`$PIDGEN_HOME/config/` when that variable is set). Change it with the installed `pidgen-worker`
commands below rather than an editor where you can. They validate the whole file first, refuse an
edit that would make it invalid or that races another edit, keep the file's comments, and ask the
running worker to apply the change without a restart.

These are the worker's own commands, not `pidgen` commands: they print text, not a JSON envelope.
They exit 0 on success, 1 when nothing was saved (an invalid `node.yaml`, or a refused or concurrent
edit; the output says why) and 2 for a command line they do not understand. A successful change
prints `saved`, then one of `applied <digest> rev <n>` (the running worker applied it),
`saved, apply pending` (it will at its next check, within a minute) or
`saved; manager not running; pending` (it applies at the next start).

### Read the current configuration

```console
pidgen-worker capacity show
pidgen-worker subscriptions show
```

`capacity show` says whether the file on disk is what the running worker applied. `subscriptions
show` lists each coding agent's provider logins in fallback order, the primary starred, each with
its login state: `ready`, `not_ready`, `unknown`, or `duplicate` (a second login to the same
provider account, which is never used).

A `node.yaml` looks like this:

```yaml
version: 2
capacity:
  prompts: {min: 2, max: 4}   # the prompt-worker pool, shared by every coding agent
  scripts: {min: 1, max: 2}   # workers for script steps
harnesses:                    # concurrent sessions per coding agent on this machine
  pi: {max: 2}
  claude: {max: 2}
  codex: {max: 0}             # 0 switches it off
```

Enrolling writes this file with `max: 2` for each coding agent found on `PATH` and `0` for the
rest. An existing file is kept.

### Resize the pools

```console
pidgen-worker capacity set prompts --min 2 --max 6
pidgen-worker capacity set scripts --max 3
```

Each pool keeps `min` workers at rest (at least 1), grows one at a time while work of its kind
waits, up to `max` (at most 64), and shrinks back to `min` after two idle minutes. Values are
absolute; an option left out keeps its value. Size the prompt pool to what the machine's memory and
CPU can carry, since every prompt worker runs a coding agent.

### Change a coding agent's session cap, or switch it on or off

```console
pidgen-worker capacity set claude --max 4
pidgen-worker capacity set codex --max 0
```

`max` caps that agent's concurrent sessions on this machine and reserves nothing, so the caps may
add up to more than the prompt pool's `max`. `--max 0` switches the agent off. An agent runs only
when it is above 0 here, its command is installed and logged in, and the person's Pidgen Account
allows it. After switching one on, run `pidgen worker doctor --format json` to confirm its command and login.

### Add a fallback provider login

A coding agent can hold up to 16 provider logins (subscriptions), tried in the order listed when
one runs out of quota. Pidgen chooses which one each attempt runs under; the worker never picks one
itself. No command adds one, so add it to `node.yaml` by hand, keeping labels unique per agent
(1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit):

```yaml
harnesses:
  claude:
    max: 4
    primary: claude-main                 # optional; defaults to the first listed
    subscriptions:
      - label: claude-main               # the agent's ordinary login
      - label: claude-second
        config_dir: ~/.claude-second     # Claude: its configuration directory
  codex:
    max: 2
    subscriptions:
      - label: codex-main
      - label: codex-second
        auth_file: ~/.codex-second/auth.json   # Codex and Pi: their auth.json
```

The person then logs the new one in at the place it names, for example
`CLAUDE_CONFIG_DIR=~/.claude-second claude /login`. It must be a different provider account from
the others, or it is `duplicate`. Apply and check:

```console
pidgen-worker capacity reload
pidgen-worker subscriptions show
pidgen worker doctor --format json
```

`capacity reload` applies the file now and answers with the validation issues when it is invalid,
changing nothing. The doctor reports each subscription as `subscription:<harness>/<label>` and fails
one that is not logged in or is a duplicate.

### Choose the primary login

The primary is the login new work runs on. On this machine, always allowed:

```console
pidgen-worker subscriptions use claude claude-second
```

From anywhere, through the Pidgen server (needs an Owner or Administrator and the Account's
`multiple_subscriptions` entitlement). The worker is its host id, as `pidgen worker status --format json` reports
it in `data.server.host_id`:

```console
pidgen worker subscriptions build-box-1 --format json
pidgen worker subscriptions use build-box-1 claude claude-second --format json
```

`pidgen worker subscriptions use --format json` sends the primary it just read, so a change someone made meanwhile
is refused rather than overwritten. `data.outcome` is `applied`, or `unknown` when the worker did not
answer in time; read the subscriptions again to see which. Add `--move-continuing` only when the
person wants work already in progress on that agent to move to the new primary too. Refusals exit 5:
`ENTITLEMENT_LIMIT_REACHED` (use `pidgen-worker subscriptions use` on the machine instead),
`WORKER_OFFLINE`, `SUBSCRIPTION_STALE` (read again and retry), `SUBSCRIPTION_UNAVAILABLE` (the label
is undeclared, not logged in, or a duplicate) and `SUBSCRIPTIONS_NOT_ENTITLED`. Exit 4 with
`HARNESS_NOT_ADVERTISED` means the worker does not run that agent.

### Environment the coding agents need

A coding agent does not inherit the shell the worker was started from. It gets an allowlisted
environment: `PATH`, `HOME`, locale, proxy and TLS-trust variables, `SSH_AUTH_SOCK`,
`GIT_SSH_COMMAND`, each agent's home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_SESSION_DIR`) and the model-provider keys (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` and similar). A variable exported only in a shell the
worker was not started from does not reach an agent. Set what the agents need before
`pidgen worker start --detach --format json`, then restart the worker (below).

Git fetches and pushes for a worker the person enrolled for their own machine use this machine's
own git credentials (credential helpers, the SSH agent). When a run fails with
`LOCAL_GIT_CREDENTIAL_REQUIRED`, the person authenticates this machine to the forge for that
repository, then retries the run.

## Day-to-day operation

| Situation | Command |
|---|---|
| Is it running and connected? | `pidgen worker status --format json` |
| Restart after changing the environment | `pidgen worker stop --format json`, then `pidgen worker start --detach --format json` |
| After a reboot (a detached worker does not survive one) | `pidgen worker start --detach --format json` |
| Stop it | `pidgen worker stop --format json` (it hands its active work back first; add `--force` only if the person accepts killing it after the timeout) |
| Its log | `data.record.log` from `pidgen worker status --format json` |

`pidgen worker stop --format json` exits 4 with `WORKER_NOT_RUNNING` when nothing is running, and 8 with `TIMEOUT`
when the worker did not stop within `--timeout` seconds (120 by default).

## Update

When `pidgen worker status --format json` reports `data.update.needed: true`, `data.update.reason` says why:
`protocol_unsupported` (the server gives this worker no work until it is updated),
`protocol_outdated` (it still does, for now) or `newer_available`. Ask the person, then:

```console
pidgen worker update --restart --format json
```

Updating installs the release with the same verification as step 3 and accepts its licence in the
same way. `--restart` restarts the running worker on the new version. If it does not start, the CLI
reinstalls the previous version and exits 1 with `UPDATE_ROLLED_BACK`; `error.details.log_tail`
says why. `ROLLBACK_FAILED` (exit 1) means the previous version could not be restored; run
`pidgen worker install --version <previous_version> --format json` with the version from `error.details`.

## Remove the worker

Only when the person asks. Ask whether to keep the worker's home, which holds its credential (kept,
installing again needs no new enrollment):

```console
pidgen worker uninstall --format json
pidgen worker uninstall --purge --format json
```

`--purge` also deletes the worker home. Revoke the worker in the Pidgen web app too, so the server
stops counting it.
