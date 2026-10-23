---
name: pidgen-setup-worker
description: Set up, diagnose and configure a Pidgen worker using the published documentation at docs.pidgen.ai and the installed commands. Use for setup failures, new model or coding-agent support, capacity and session caps, harness options, multiple provider subscriptions, and worker updates or restarts. To recover a ticket's failed run, use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Set up and configure a worker

A worker is the `pidgen-worker` program running on a machine the person controls. It connects out
to their Pidgen server with its own credential, claims the Account's work, and drives the coding
agents installed here (Claude Code, Codex, Pi). The CLI installs, enrolls and runs it; the worker
owns its own configuration.

## Find the right documentation first

Use [Pidgen Docs](https://docs.pidgen.ai/) as the public source of truth. Open only the pages
relevant to the request, using the agent's browsing tools; follow their navigation if a link moves.
The CLI and worker ship separately, so a current documentation page may describe something an
older installation cannot do. Read the CLI version with `pidgen --version`, the installed worker
version from `data.update.installed` in `pidgen worker status --format json`, and the relevant
command's `--help` before relying on unfamiliar flags. Help and version output are text.

| Task | Documentation to read | Section below |
|---|---|---|
| Diagnose setup or connection | [CLI troubleshooting](https://docs.pidgen.ai/cli/troubleshooting/), [install a worker](https://docs.pidgen.ai/cli/install-worker/) | Diagnose before changing anything |
| Add model or coding-agent support | [New model guide](https://docs.pidgen.ai/cli/worker-models/), [coding agents](https://docs.pidgen.ai/worker/coding-agents/), [worker lifecycle](https://docs.pidgen.ai/cli/workers/) | New models and coding agents |
| Change capacity | [Configure the worker](https://docs.pidgen.ai/worker/configure/) | Resize the pools; change a session cap |
| Customize harness options or restrict models | [Worker policy reference](https://docs.pidgen.ai/cli/worker-policy/), [worker configuration](https://docs.pidgen.ai/worker/configure/#the-worker-policy), [restrict models](https://docs.pidgen.ai/cli/install-worker/#restrict-the-models-this-machine-runs), [agent environment](https://docs.pidgen.ai/worker/coding-agents/#the-agents-environment) | Customize harness options; Restrict the models this machine runs |
| Use multiple subscriptions | [Subscriptions](https://docs.pidgen.ai/worker/coding-agents/#subscriptions), [remote primary selection](https://docs.pidgen.ai/cli/commands/#worker-subscriptions) | Add a fallback provider login |
| Worker starts but work waits or fails | [Worker troubleshooting](https://docs.pidgen.ai/worker/troubleshooting/), [logs and diagnostics](https://docs.pidgen.ai/worker/logs-and-diagnostics/) | Diagnose before changing anything |
| Survive a reboot | [Run as a service](https://docs.pidgen.ai/worker/run-as-a-service/) | Day-to-day operation |

Cite the page supporting a recommendation. Check the provider's official documentation as well
when the request depends on a model's availability or a harness version; a provider announcement
alone does not establish Pidgen support. Do not substitute remembered model names, policy keys or
provider plan limits. If documentation cannot be reached, say so and use version-matched local
documentation, the installed schema and example, installed help and the known commands below;
leave changes without supporting evidence unresolved. When documentation and
installed help disagree, report both versions and the mismatch rather than trying unknown flags.
After a CLI upgrade, refresh the bundled skills with `pidgen skills install --format json`.

## Diagnose before changing anything

Establish which machine, operating-system user, worker home (`PIDGEN_HOME` when set), and launch
method (CLI detached, service, or container) the request concerns. A local command changes the
worker on this machine, not an arbitrary remote worker. Use the same user and environment as the
worker; a login or executable visible in an interactive shell may be missing from a service.

```console
pidgen doctor --format json
pidgen worker status --format json
pidgen worker doctor --format json
```

On a fresh machine, use the first report to proceed through setup; worker checks cannot succeed
before installation. For an existing worker, read failed checks and remedies, `data.warnings`,
`data.running`, the server connection state when available, and the failing command's exit code.
For setup failures, read `error.details.step`, `command`, and `fix`, plus the relevant excerpt of
the setup log it reports. For a worker exit, read `error.details.log_tail` or the log identified by
status. Keep credentials and unrelated log content out of replies.

Distinguish a missing runtime, CLI sign-in/enrollment permission, installation or provenance
failure, worker connection, harness executable/login, and invalid configuration. Apply the
reported remedy to that layer, then repeat the failing check. Do not reinstall, re-enroll, purge
the worker home, or disable a harness as a generic repair. Check the launch method before starting
a worker: a service-managed worker may have no CLI detached-process record. Do not start a second
manager beside it. A successful status command alone does not prove readiness; an unavailable
server view is missing evidence, not proof that enrollment is broken.

Before running configuration commands by name, check whether another `pidgen-worker` is first
on `PATH`. The CLI uses its recorded executable (or `PIDGEN_WORKER_BIN`),
which may differ from the shell's. Use that installation for both diagnosis and changes.

Show the concrete change and expected effect before changing configuration, and preserve the
person's unrelated settings. Use existing authorization for the requested change. Commands that
support preview require preview → apply with its digest and only explicitly accepted `--ack`
codes. Local capacity commands and subscription selection act directly; do not invent preview
flags for them. Browser sign-in and licence acceptance still belong to the person.

## Set up a new worker

`pidgen setup --format json` does this whole path, but it asks questions and so runs only on a terminal. From an
agent's shell it exits 2 with `TERMINAL_REQUIRED` and lists the same steps in
`error.details.commands`. Follow the steps below instead, which are those commands with the
decisions spelled out. With `--format json`, read the envelope's `data`, and branch on the exit
code and `error.code`; foreground worker streams, help and version are text exceptions.

## What pidgen setup does

When the person has a terminal, suggest they run setup themselves. It goes through eight steps, one
question or task at a time, each question a prompt they answer with the arrow keys, space and
Enter, collapsing to one line once answered:

| Step | What it does |
|---|---|
| 1. Check this machine | Runs the doctor checks; offers to install `uv` when it is missing (uv's own installer, after the person says yes); stops when `git` is missing or older than 2.38, with the install command for this system (macOS, or the Linux distribution in `/etc/os-release`) |
| 2. Sign in to Pidgen | Device-code sign-in, the Account question when the person belongs to several, and whether the credential may enroll workers |
| 3. Choose coding agents | Checkboxes of Claude Code and Codex, those on `PATH` ticked; ticking a missing one installs it with `npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`, with no further question; Pi is shown, disabled, when it is on `PATH` |
| 4. Sign in to coding agents | Each chosen agent's status first, then the agent's own login, the same as `pidgen worker login claude --format json`, only for those not signed in |
| 5. Size coding agent sessions | Asks how many sessions each agent runs at once: numbers with plan hints (table in "Change a coding agent's session cap"), or Custom, any whole number from 1 |
| 6. Install the worker | One question, install pidgen-worker <version> and accept its licence, then the install and its verification |
| 7. Enroll and start the worker | Enrolls, applies the caps with `pidgen-worker capacity set`, starts the worker and waits until it is connected |
| 8. Prove the worker works | The worker's own checks, then the time taken and the next thing to do |

Flags answer the questions in advance, for example
`pidgen setup --agent claude --sessions claude=2 --format json`: `--agent` (repeatable) chooses the
coding agents and `--sessions <agent>=<n>` (repeatable) how many sessions each runs at once;
`--plan <agent>=<plan>` (repeatable) still answers it from a plan instead, but not together with
`--sessions` for the same agent. `--accept-licence` answers the install question; only the person
may give it. Ctrl-C at a question exits 2 with `SETUP_CANCELLED`, keeping what was done. A failed
step's error names the step and its fix, and says that running setup again continues from there; a
re-run skips what is already done and applies the caps again. On a finished machine a re-run asks
the person what to do (check, change the coding agents or sessions, or update the worker), unless
`--agent`, `--sessions` or `--plan` are given. A credential that cannot enroll workers stops setup at
sign-in with `ENROLL_NOT_PERMITTED`, before anything is installed. On a machine whose worker was
removed from the Account, setup asks `Enroll it again?`; yes moves the removed worker's `worker.env`
aside (`worker.env.replaced-<UTC timestamp>`), as
`pidgen worker enroll --replace-credential --format json` does, so the worker redeems the new enrollment and connects. A `worker.env` holding a credential for another
server stops setup at the enroll step with `WORKER_CREDENTIAL_PRESENT`, before anything is enrolled.
Before enrolling, setup always asks the person `Worker name`, with a suggestion filled in (the
removed worker's name, else this machine's host name, else the next free name) that Enter accepts;
`--label` answers it in advance. When the Account lists this install's worker (by the install id the
worker home keeps in `install-id`) live but its credential is gone, setup says so and asks
`Replace <name>?`: the person removes it on the Workers page and setup enrolls under its name once
it is listed as removed, or declines and gets a new name. When Pidgen refuses the worker's name as taken, setup says so in one
line and asks again, defaulting to the name the server suggests (`WORKER_NAME_TAKEN`) or the next
free one (`WORKER_HOST_TAKEN`); with `--label` it stops with that code (exit 5), its fix naming the
name to give as `--label`.

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
| `runtime` | `uv` is missing. Guided setup offers to install it; from here, give the person the `fix` |
| `releases` | The server's worker release list could not be read. Nothing can be installed until it can; report the `summary` and stop |
| `harness:<kind>` | That coding agent's command is not on `PATH`. One missing beside another found is fine; all missing is a `fail`, and the person installs at least one: `npm install -g @anthropic-ai/claude-code` (Claude Code) or `npm install -g @openai/codex` (Codex) |
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
proprietary software under its own end-user licence agreement, which they can read at
https://pidgen.ai/legal/eula, that installing it accepts the agreement, and that the command prints
the notice. Install only after they agree.

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

Between the two, size each coding agent from the person's plan (ask them; the table is in
"Change a coding agent's session cap"). Enrolling wrote `node.yaml`, so the caps can be set now.
The CLI installs the worker in `~/.pidgen/worker/bin`, which is not on `PATH`, and runs it by
that path; put the directory on `PATH` first (`export PATH="$HOME/.pidgen/worker/bin:$PATH"`) to
run `pidgen-worker` by name. For Claude Code on Max 5x alone:

```console
pidgen-worker capacity set claude --max 2
pidgen-worker capacity set codex --max 0
pidgen-worker capacity set pi --max 0
pidgen-worker capacity set prompts --min 1 --max 2
```

Each chosen agent gets its cap, every other agent `--max 0`, and the prompt pool `--min 1` and the
sum of the caps as `--max`. Each command prints `saved` (with `saved, apply pending` or
`saved; …` after it when the worker is not running yet); exit 1 means the edit was refused and the
output says why.

`--no-install` because step 3 installed it. Enrolling does not start the worker;
`pidgen worker start --detach --format json` does, and the CLI records that worker so it can stop it and report
on it.

`pidgen worker enroll --format json` creates a one-time enrollment and hands it to the worker, which exchanges it
for its own credential. The token is never printed and you never see it. `data.enrolled` is `true`
on success.

| Exit | `error.code` | Meaning and next step |
|---|---|---|
| 3 | `FORBIDDEN` | The credential may not enroll workers; go back to step 2 |
| 2 | `WORKER_NOT_FOUND` | The worker the install record names (`error.details.location`) is missing: run `pidgen worker install --force --format json` and enroll again |
| 5 | `WORKER_CREDENTIAL_PRESENT` | The worker home's `worker.env` (`error.details.path`) already holds a credential and nothing was enrolled. If the worker is still listed in the Account, run `pidgen worker start --detach --format json` to use it; if it was removed from the Account, run `pidgen worker enroll --replace-credential --label <label> --no-install --format json`, which moves the file aside (`data.replaced`) and enrolls anew |
| 5 | `WORKER_NAME_TAKEN` | The Account already holds the name in `error.details.display_name`, by a live worker or a pending enrollment, and no enrollment was created. Offer the person `error.details.suggested_name`, and run `pidgen worker enroll --label <name> --no-install --format json -- --host-id <name>` with the name they choose |
| 5 | `WORKER_HOST_TAKEN` | Pidgen refused the host id in `error.details.host_id`: another worker holds it, in this Account or another, and removing a worker in the web app does not free its name. Ask the person for another name and run `pidgen worker enroll --label <name> --no-install --format json -- --host-id <name>` |
| 1 | `ENROLL_FAILED` | The worker refused; its reason is on standard error. The CLI withdrew the enrollment it created (`error.details.withdrawn` is `true`), so nothing is left waiting; read the reason before retrying |

`pidgen worker start --detach --format json` waits two seconds. Exit 1 with `WORKER_EXITED` means the worker
stopped at once; read `error.details.log_tail`. Exit 5 with `WORKER_ALREADY_RUNNING` means one is
already running, which is fine.

## 5. Confirm it connected and works

```console
pidgen worker status --format json
pidgen worker doctor --format json
```

In `pidgen worker status --format json`, `data.running` must be `true`, and with an Owner or Administrator's
credential `data.server.worker.connected` should turn `true` within a minute or two. Check again
over that interval; if it stays disconnected, inspect warnings and logs instead of polling forever.
`data.server` can be absent or `null` when the credential cannot read the Account's workers or the
server is unreachable. Report that limit: local status and doctor checks do not prove a server
connection. `data.update.needed` says whether a newer
release should be installed (section "Update").

`pidgen worker doctor --format json` runs the worker's own checks. `data.ok` is `true` when all pass; each entry
of `data.checks` has `name`, `ok`, `summary` and, when it fails, `defect` and `remedy`. A failure
exits 1 with `DOCTOR_FAILED` and the report in `error.details`. Typical failures and their remedies:

- **A coding agent is not logged in.** The person runs `pidgen worker login claude --format json` or
  `pidgen worker login codex --format json` in their own terminal: it runs the agent's login there
  and returns `data.login`, `ready` when it worked. You never handle their credentials.
- **A coding agent's command is missing** while the worker is set to run it: install it, or switch
  that agent off (section "Configure the worker").
- **`git`, `node` or `npm` is missing or too old:** the person installs it. The worker needs `git`
  2.38 or later; the `git` check's `fix` names the command for their system (on Ubuntu 22.04, whose
  own git is 2.34, the git-core PPA).

Once the doctor passes, offer the next step: install these skills into the person's coding agents
with `pidgen skills install --format json`, then file a first ticket (see pidgen-file-ticket).
Before the first ticket in a Project, the Project's repository needs its workspace setup under
`.pidgen/`; to check it, write or propose it and rehearse it on this worker
(`pidgen project rehearse STO --format json`), follow pidgen-project-readiness. When Tickets keep
failing at provision, activate or their tests, its `pidgen project doctor STO --format json` says
whether the setup is the problem.

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

Read these before editing and record the values you intend to change. Afterwards run
`pidgen-worker capacity show` again: a saved file or exit 0 with `apply pending` is not proof the
running worker applied it. Allow the documented minute for reload, then inspect the refusal or
manager state if the digests still differ. When stopped, report the change as saved for next start.
If the manager is running with no actionable remedy and the digests still differ, report the
pending change and prepare a support summary instead of repeatedly writing or polling.
Run `pidgen worker doctor --format json` after configuration changes. Undo only your own change if
it fails validation, preserving any concurrent edits; do not replace the whole file from a sample.

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
Check both the shared prompt pool and the requested harness cap before raising either; an idle
prompt worker can coexist with a saturated harness cap. Lowering capacity drains busy sessions
without interrupting them. Do not restart the worker merely to apply a capacity change.

### Change a coding agent's session cap, or switch it on or off

```console
pidgen-worker capacity set claude --max 4
pidgen-worker capacity set codex --max 0
```

`max` caps that agent's concurrent sessions on this machine and reserves nothing, so the caps may
add up to more than the prompt pool's `max`. Prefer the person's requested cap, within 0–64, and
consider machine resources and observed provider limits. Guided setup offers these starting
values; they are sizing hints, not provider entitlements or guaranteed concurrency limits:

| Coding agent | Plan | Sessions at a time | `--plan` value |
|---|---|---|---|
| Claude Code | Pro | 1 | `claude=pro` |
| Claude Code | Max 5x | 2 | `claude=max-5x` |
| Claude Code | Max 20x | 4 | `claude=max-20x` |
| Claude Code | API key, Team or Enterprise | 2 | `claude=api` |
| Claude Code | Not sure | 1 | `claude=not-sure` |
| Codex | Plus | 1 | `codex=plus` |
| Codex | Pro | 3 | `codex=pro` |
| Codex | Business or Enterprise | 2 | `codex=business` |
| Codex | API key | 2 | `codex=api` |
| Codex | Not sure | 1 | `codex=not-sure` |

A person with a terminal can also size them again with
`pidgen setup --agent claude --sessions claude=4 --format json` (or `--plan claude=max-20x` for `--sessions`),
which applies the caps without enrolling again. `--max 0` switches the agent off. An agent runs only
when it is above 0 here, its command is installed and logged in, and the person's Pidgen Account
allows it. After switching one on, run `pidgen worker doctor --format json` to confirm its command and login.

### New models and coding agents

Identify the requested provider/model, the harness that should run it, and the observed failure
or missing option. Keep three checks separate:

1. **Provider and harness support:** confirm the exact model identifier and supported harness
   version from current official documentation. A provider login alone does not prove access to
   that model. If a harness update is needed, use its documented installation path in the worker's
   environment and verify its version afterwards.
2. **Worker readiness:** confirm that the installed worker supports that harness, its executable
   and login are available to the worker's user, and its session cap is above zero. Use doctor and
   the configuration readback. Follow the update section only when a worker update is needed;
   do not reinstall or re-enroll merely because a new model was released.
3. **Pidgen availability and selection:** confirm the Account allows that harness and offers the
   requested model through a documented application workflow. The CLI has no model-registration
   command. A ticket's `team_member_id` is an Account Agent ID, not a model name. Do not add model
   keys to `node.yaml`, invent a model command, or call unpublished routes to make a model appear.

The new model guide covers local readiness and executable selection. In the public worker
2.11.1 policy, `harnesses.claude.cli_path` selects an absolute executable path in place of the
SDK-bundled Claude CLI: updating the shell's Claude alone does not select it for worker turns.
This setting belongs under the harness in worker policy, not in `node.yaml`, and it neither
registers nor selects a model in the application. Codex has no `cli_path` policy key. Read the
versioned guide before editing; do not assume older releases support these keys. Which models
exist and which accept images is the App Service's model list, chosen in the setup flow, not on
the worker: never declare a model's input capabilities in the worker's policy. The only model
setting on a worker restricts which of those models it runs; see Restrict the models this
machine runs.

If no published procedure covers the request, state which layer is
verified and which is unsupported or unknown, and prepare a support question with the model,
harness and versions. A green doctor proves local readiness, not that the requested model ran.
When an execution check is needed, use work the person authorized and inspect its reported model
and result; do not create a ticket or consume provider quota merely as an unrequested test.

### Customize harness options

Read the published worker policy and agent environment sections linked above. `node.yaml` owns
capacity and subscriptions. `PIDGEN_WORKER_POLICY`, or `config/worker-policy.yaml` under the worker's
home when no override is set, owns how a harness
runs, including supported executable paths, sandbox/network settings, Claude's
`environment_allowlist` and the `harnesses.<name>.models` allow and deny lists that restrict which
models a harness runs (next section). Changing the policy does not enable a harness whose cap is
zero.

Inspect the installed policy's relevant section and comments, and confirm the requested key,
type, allowed values and reload behavior against the versioned policy reference and the schema
and annotated example shipped with that worker. The reference distinguishes shipped example
values from defaults for omitted keys. If an option is undocumented, do not infer its
spelling or nesting from a harness CLI flag. Explain the missing reference and prepare a support
question instead of writing an unverified key. Unknown keys can stop the worker from starting.

For a documented option, make a minimal edit preserving the existing file and unrelated options.
For additional Claude environment variables, add only the required variable names to the existing
`environment_allowlist`; supply their values through the worker's documented environment, never
credential literals in the policy. An exported shell variable is not automatically inherited by a
harness. Explain the effect of any requested sandbox or network change; do not disable protections
as a general troubleshooting remedy.

### Restrict the models this machine runs

The worker policy's `harnesses.<name>.models` block is the only model setting on a worker, and it
is documented: edit it when the person asks to keep a harness on this machine to some models or
away from others. It holds two lists, `allow` and `deny`, both empty by default. The matching
rules:

- An empty `allow` lets every model run; a nonempty `allow` runs only the models matching one of
  its entries.
- A model matching any `deny` entry never runs on this machine, even when `allow` matches it:
  `deny` wins.
- An entry matches a model's identifier exactly, except that `*` matches any run of characters,
  so `claude-opus-*` matches every Opus model.
- Claude and Codex entries are model IDs. Pi entries are `provider/model-id`, such as
  `anthropic/claude-*`.

```yaml
harnesses:
  claude:
    models:
      allow: ["claude-sonnet-*", "claude-opus-*"]
      deny: ["claude-opus-4-1*"]
  pi:
    models:
      deny: ["openai/*"]
```

The shipped `worker-policy.yaml` restricts nothing: its lists are empty, so the harness runs
every model Pidgen sends it. Which models exist and which accept images is decided in the App
Service's setup flow, where the Account chooses its model list, not on the worker. Do not add a
model to `allow` to make it available, and do not look for a worker key that declares a model or
its image input. Make the same minimal, preserving edit as for any documented option, keep the
exact keys above, and restart the worker through the method that already manages it so the
change takes effect.

Run `pidgen worker doctor --format json` after the edit. For harness-policy edits, restart using
the existing launch method so new processes load the policy, and inspect readiness afterwards.
Use `pidgen worker restart --format json` for a CLI-managed worker; use the service manager for a
service. Capacity reload is not a policy reload command. A failed validation calls for correcting
or undoing the edit before restarting, not repeated restarts.

### Add a fallback provider login

A coding agent can hold up to 16 provider logins (subscriptions), tried in the order listed when
one runs out of quota when the Account's plan permits automatic fallback. Without that, only the
primary is used. Pidgen chooses which one each attempt runs under; the worker never picks one
itself. Inspect the existing entries first. No command adds one, so add it to `node.yaml` by hand,
preserving other entries and settings and keeping labels unique per agent
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
the others, or it is `duplicate`; another login to the same account does not add quota.
For Codex and Pi, follow the published login instructions for the separate home containing the
declared `auth_file`. Store paths in `node.yaml`, never credentials, and do not read or copy the
authentication files. `unknown` means the worker cannot inspect the login (for example a keychain
login), not necessarily that it is logged out. Do not substitute another subscription without
the person's direction. If usability needs confirmation beyond doctor, use the provider's
documented status check or authorized work; report it as unverified until there is evidence.
Apply and check:

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
`multiple_subscriptions` entitlement). The worker is its name or its id, as `pidgen worker status --format json`
reports them in `data.server.display_name` and `data.server.host_id`:

```console
pidgen worker subscriptions build-box-1 --format json
pidgen worker subscriptions use build-box-1 claude claude-second --format json
```

`pidgen worker subscriptions use --format json` sends the primary it just read, so a change someone made meanwhile
is refused rather than overwritten. `data.outcome` is `applied`, or `unknown` when the worker did not
answer in time; read the subscriptions again to see which. Add `--move-continuing` only when the
person wants work already in progress on that agent to move to the new primary too. Refusals exit 5:
`ENTITLEMENT_LIMIT_REACHED` (use `pidgen-worker subscriptions use` on the machine instead),
`WORKER_OFFLINE`, `SUBSCRIPTION_STALE` (read again and reconcile the concurrent selection with the
person's intent before retrying; do not blindly overwrite another person's choice), `SUBSCRIPTION_UNAVAILABLE` (the label
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
| Restart after changing the environment | `pidgen worker restart --format json` (stops it, then starts it detached again with the arguments it was started with, in this shell's environment) |
| After a reboot (a detached worker does not survive one) | `pidgen worker start --detach --format json` |
| Stop it | `pidgen worker stop --format json` (it hands its active work back first; add `--force` only if the person accepts killing it after the timeout) |
| Its log | `data.record.log` from `pidgen worker status --format json` |

`pidgen worker stop --format json` and `pidgen worker restart --format json` exit 4 with `WORKER_NOT_RUNNING` when nothing is running, and 8 with `TIMEOUT`
when the worker did not stop within `--timeout` seconds (120 by default); a restart that times out leaves the old worker running. A restarted worker that exits during the startup check exits 1 with `WORKER_EXITED`, as `worker start --detach` does.

## Update

When `pidgen worker status --format json` reports `data.update.needed: true`, `data.update.reason` says why:
`protocol_unsupported` (the server gives this worker no work until it is updated),
`protocol_outdated` (it still does, for now) or `newer_available`. Explain the version and restart
impact, and obtain agreement if updating and accepting the licence are not already authorized:

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

## When support is needed

If a failure persists after its documented remedy, or a model/option lacks a supported procedure,
summarize the requested outcome, CLI and worker versions, harness version if relevant, launch
method, error code and failing check, the change tried, its readback, and the documentation used.
Keep the report small and remove tokens, authentication contents and sensitive log details.
Distinguish observed facts from suspected causes and name the missing command or documentation.

Prepare the report for the person. Only send it when they ask to submit feedback:

```console
pidgen feedback --kind not-working --message-file support-summary.txt --format json
```

Use `--kind improvement` for a missing capability. This sends immediately, without preview, and
permits follow-up contact by default; use `--no-contact` if requested. Return `data.reference` after
submission. Do not automatically file feedback, a ticket or a public issue during diagnosis.
