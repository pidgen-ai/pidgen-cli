# Install and connect a worker

A worker runs Pidgen work on a machine you control. Install it on the machine that will execute
the work; you can use the CLI from other machines without installing a worker on each one.
The worker is the separate `pidgen-worker` program, with its own licence and credential.

## Before you start

You need:

- The [Pidgen CLI](getting-started.md#1-install-the-cli), which needs Node.js and npm.
- Linux on x86_64 or aarch64, or macOS on Intel or Apple silicon.
- `git` 2.38 or later. `pidgen doctor` and setup name the command for your system when it is
  missing or older:

  | System | Command |
  |---|---|
  | macOS | `xcode-select --install` (Apple's Command Line Tools) or `brew install git`; when the Command Line Tools' git is older, `brew install git` from [Homebrew](https://brew.sh), with Homebrew's bin directory before `/usr/bin` on `PATH`, or update the Command Line Tools through Software Update |
  | Ubuntu, Linux Mint, Pop!_OS | `sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git` (Ubuntu 22.04's own git is 2.34) |
  | Debian | `sudo apt update && sudo apt install git`; Debian 12 or later packages a new enough git, and for older releases see <https://git-scm.com/downloads/linux> |
  | Fedora, RHEL, CentOS Stream, Rocky, AlmaLinux, Amazon Linux | `sudo dnf install git`, or `sudo dnf upgrade git` for an older one |
  | Arch, Manjaro | `sudo pacman -S git` |
  | Alpine | `sudo apk add git`, or `sudo apk upgrade git` for an older one |
  | openSUSE, SLES | `sudo zypper install git` |
  | Any other Linux | Install git 2.38 or later with your package manager: <https://git-scm.com/downloads/linux> |

  On Linux the distribution comes from `/etc/os-release`: its `ID`, then each `ID_LIKE` entry.
- A subscription or API key for at least one coding agent: Claude Code or Codex.
- Permission to enroll a worker: an Account Owner or Administrator, or an eligible Personal API
  Token with `workers:enroll`.
- Network access to Pidgen and the package and verification services used to install the worker.

Setup installs what else the machine lacks, each only after you say yes: `uv`, which installs the
worker into its own Python 3.12 environment, and the coding agents you choose. You do not need to
install `pidgen-worker` yourself first.

## 1. Run guided setup

In a terminal on the worker machine, run:

```sh
pidgen setup
```

Setup goes through eight steps, one question or task at a time, in a frame that starts with
`┌  Pidgen setup`. Each question is a prompt you answer with the arrow keys, space and Enter, and
collapses to one line once answered, such as `◇  Claude Code · 2 sessions at a time`. Each task,
such as installing the worker, shows a spinner while it runs and then collapses to one line, such
as `◇  pidgen-worker 2.11.0 installed and verified`. The commands setup runs and their output go to
[the setup log](#the-setup-log), not the screen; `--verbose` shows them as they run. Ctrl-C at a
question, during a task or while setup waits for you to sign in, or SIGTERM, stops setup with
`Setup cancelled. Everything before this is kept.` (exit 2); run it again to continue.

A first run looks like this:

```text
┌  Pidgen setup
│
◇  This machine is ready · Linux · Node.js 24.16 · git 2.43
│
◆  Sign in to Pidgen
│  Open this link and approve the sign-in:
│    https://pidgen.example.com/device?code=WXYZ-1234
│  Or go to https://pidgen.example.com/device and enter  WXYZ-1234
│
◇  Signed in as sam@example.com · Acme · Administrator
│
◇  Coding agents · Claude Code
│
◇  Claude Code signed in
│
◇  Claude Code · 4 sessions at a time
│
◇  Install pidgen-worker 2.11.0 and accept its licence? · Yes
│
◇  pidgen-worker 2.11.0 installed and verified
│
◇  Enrolled as sams-laptop (wkr_…) in Acme
│
◇  Worker running and connected to Pidgen as sams-laptop (wkr_…)
│
◇  Worker checks passed
│
└  Done in 4 min 12 s

  This machine is a Pidgen worker

  Account        Acme · sam@example.com
  Worker         sams-laptop · pidgen-worker 2.11.0 · running
  Coding agents  Claude Code · 4 sessions at a time

  Manage it
    pidgen worker status    what it's doing now
    pidgen worker stop      stop it
    pidgen setup            change coding agents or sessions

  Next: install the agent skills so your coding agent can file and follow work
    pidgen skills install
```

| Step | What happens |
|---|---|
| 1. Check this machine | Runs `pidgen doctor` and shows one line, `This machine is ready · <system> · Node.js <version> · git <version>`. Checks a later step fixes (the sign-in, the coding agents, the install) and warnings that do not apply to what setup does (the container runtime's `cosign`) go only to the setup log. When `uv` is missing, setup asks `uv installs the worker and isn't on this machine. Install it?` and, when you say yes, runs uv's installer, `curl -LsSf https://astral.sh/uv/install.sh \| sh`. A missing `git`, or one older than 2.38, stops setup with the command that installs it on this system |
| 2. Sign in to Pidgen | Signs you in with a device code: open the link it shows (it carries the code), or go to the address and enter the code. While it waits it shows how long it has waited and when it last checked, and the keys `Enter open in browser · n new code · Esc other options` (see [The sign-in wait](#the-sign-in-wait)). It asks which Account the worker serves when you belong to several, and shows `Signed in as <email> · <Account> · <Role>`. A credential that cannot enroll workers stops setup here, before anything is installed, naming the roles that can (an Owner or Administrator) and the Personal API Token sign-in, `pidgen auth login <url> --with-token --account <ACC-…>` |
| 3. Choose coding agents | Shows Claude Code and Codex as checkboxes, with the ones already on `PATH` ticked; a missing one is labelled `not installed · setup installs it with npm`. Ticking it installs it with `npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`, with no further question. Pi is shown, and can't be ticked, when it is on `PATH`: the worker runs it, and setup doesn't manage it. Choose at least one |
| 4. Sign in to coding agents | Asks each chosen agent whether it is signed in, and for those that are not, runs `pidgen worker login <agent>` when you press Enter. The agent's own login runs in your terminal |
| 5. Size coding agent sessions | Asks how many of each chosen agent's sessions run at once: a number, with the plans it suits as hints, or *Custom…* (see [Plans and session caps](#plans-and-session-caps)) |
| 6. Install the worker | Asks once, `Install pidgen-worker <version> and accept its licence?`, naming the licence in one line and linking its full text, `Read it: https://pidgen.ai/legal/eula`, in the next (see [The install question](#the-install-question)); no stops setup, and the worker isn't installed. Then it installs the worker in its own environment under `~/.pidgen/worker` and verifies its signature. When uv already holds another `pidgen-worker`, setup leaves it alone and says so in one `▲` line |
| 7. Enroll and start the worker | Asks `Worker name`, with a suggested name filled in that Enter accepts and you can edit (see [The name question](#the-name-question)), then enrolls this machine under it, applies the session caps, starts the worker in the background, and waits until Pidgen reports it connected |
| 8. Prove the worker works | Runs the worker's own checks |

### The sign-in wait

While setup waits for you to approve the sign-in, it checks with Pidgen at the server's interval
and shows a live line and the keys it answers:

```text
◒  Waiting for you to approve in the browser… 1m 12s · checked 2s ago
│  Enter open in browser · n new code · Esc other options
```

- **Enter** opens the link in your browser with `open` on macOS, or `xdg-open` (`wslview` under
  WSL) on Linux, so you don't have to select it in the terminal. Without either, Enter checks for
  your approval at once (never sooner than the server's interval after the last check).
- **n** drops the code, gets a new one and shows it.
- **Esc** stops waiting and asks `Sign-in isn't finished. What next?`: *Wait again with a new code*
  (the default), *Sign in with a token instead*, which stops setup and shows
  `pidgen auth login <url> --with-token --account <ACC-…>` to run with a Personal API Token, or
  *Quit setup*.
- A code that expired before you approved it, a sign-in that was denied, or one Pidgen no longer
  recognises doesn't stop setup: it says what happened in one line and asks the same question,
  with a new code as the default.
- When Pidgen can't be reached, the line says `Can't reach <server>; still trying` and setup keeps
  checking until the code expires.
- **Ctrl-C** (or SIGTERM) stops setup with `Setup cancelled. Everything before this is kept.`.

Each check goes to [the setup log](#the-setup-log) with its time and outcome (never the code or the
token), and `poll delayed <n>s` when one was held up.

### The install question

Before anything is downloaded or run, setup asks once, naming the worker's licence and linking its
full text, the Pidgen Worker End-User Licence Agreement:

```text
◆  Install pidgen-worker 2.11.0 and accept its licence?
│  The worker is proprietary software under the Pidgen Worker End-User Licence Agreement.
│  Read it: https://pidgen.ai/legal/eula
│  ● Yes  ○ No
└
```

Once answered, it collapses to the one `◇` line in the first run above. `--accept-licence` answers
it in advance and shows only that line, ending `· Yes (from --accept-licence)`; the setup log
records the licence's two lines under the question either way.

A successful run ends with `└  Done in <m> min <s> s` and a summary card on standard output: the
Account, the worker's name, version and state, each coding agent's sessions, the commands to manage
the worker, and the one next thing to do (`pidgen skills install`, or `pidgen ticket template` once
the skills are current). The card adds `Open a new terminal to use uv by name.` when setup
installed uv where `PATH` does not reach yet, and `Check it's connected: pidgen worker status,
signed in as an Owner or Administrator.` when your credential could not read the Account's
workers. With `--format json` (or standard output not a terminal), the frame ends with the
`└  Done in` line on standard error and standard output carries only the envelope.

### Running setup again

Setup decides what is done from this machine. When everything is (signed in, the worker installed,
enrolled and running, its coding agents' sessions set), it says so in one line and asks what to do:

```text
◇  Already set up · Acme · Claude Code · pidgen-worker 2.11.0 · running
│
◆  What do you want to do?
│  ● Check everything and stop
│  ○ Change coding agents or sessions
│  ○ Update the worker to 2.12.0
└
```

*Check everything and stop* runs the worker's checks and confirms it is connected, without asking
anything more; when a newer release is out it says so in one line,
`◇  pidgen-worker 2.12.0 is available (2.11.0 installed) · update with pidgen worker update`, and
installs nothing. *Change coding agents or sessions* asks those questions again and applies the new
caps. *Update the worker* is offered only when `pidgen worker update` would install a newer release: the
newest of the server's current series on the installed version's track (final releases, and
pre-releases too while a pre-release is installed), so a machine on `2.11.1b1` is offered `2.11.1b2`
and never `2.11.0`. It runs `pidgen worker update --restart`. `--agent`, `--sessions` and `--plan`
answer the question in advance: change them.

On a machine where only part is done, setup collapses what is done into one line, such as
`◇  Already done · signed in to Acme · pidgen-worker 2.11.0 installed`, and continues with the
rest.

Before such a run starts the worker, setup compares the installed worker with the newest release on
its track, by the rule `pidgen worker update` follows (final releases, and pre-releases too while a
pre-release is installed; never an older release). When one is newer, it asks once:

```text
◆  pidgen-worker 2.11.1 is available (2.11.0 installed). Update before starting?
│  ● Yes  ○ No
└
```

Yes, the default, asks the licence question again for the new release, since a new release may
carry a new licence (`Install pidgen-worker 2.11.1 and accept its licence?`), then runs
`pidgen worker update --restart` and starts the new release. No, to either question, keeps the
installed release and starts it, with `◇  pidgen-worker 2.11.0 is installed · update it later with
pidgen worker update`. `--accept-licence` answers both questions yes in advance. Nothing is asked
when nothing newer is out (a newer beta is not offered while a final release is installed), when
`--version` names the release, or when the server's releases or the package index cannot be read
(the setup log notes why).

Guided setup currently supports the **wheel** runtime. Container installation and management
commands are available, but container enrollment through the CLI and guided container setup are
*planned*. Follow the wheel path for a complete CLI setup today.

### Answer questions in advance

Flags answer setup's questions before it asks them:

```sh
pidgen setup --agent claude --sessions claude=2 --accept-licence --label development-worker
```

- `--agent claude` or `--agent codex` chooses a coding agent; repeat it for both.
- `--sessions <agent>=<n>` says how many of that agent's sessions run at once, a whole number from
  1; repeat it for each agent. `--plan <agent>=<plan>` answers the same question with a plan from
  the table below instead; give one of them for each agent, not both.
- `--accept-licence` installs the worker and accepts its licence without asking; on a re-run it
  also says yes to updating to a newer release before the worker starts.
- `--runtime wheel` names the runtime (the only one setup offers, so it is never asked), and
  `--label` names the worker (default: this machine's host name). The name is the enrollment's
  label and the worker's name in the Account, its `display_name`, which `pidgen worker status` and
  the web app show beside the worker's id. Pidgen gives the worker its id (`wkr_…`) when it
  enrolls.

For another Pidgen server, add `--url https://pidgen.example.com`, replacing the placeholder with
your server address.

To sign in to a coding agent outside setup, run `pidgen worker login claude` or
`pidgen worker login codex`. It runs the agent's own login in your terminal, then reports whether
the agent is signed in.

### Plans and session caps

Each coding agent's cap is how many of its sessions the worker runs at once. Setup offers numbers
with the plans they suit as hints, starting on the lowest (or, on a re-run, on the worker's current
cap); *Custom…* takes any whole number from 1. The hints are starting values, not the providers'
limits. `--plan` takes a plan instead, from this table:

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

After enrolling, setup applies the caps with the worker's own capacity command. For Claude Code on
Max 5x alone, it runs:

```sh
pidgen-worker capacity set claude --max 2
pidgen-worker capacity set codex --max 0
pidgen-worker capacity set pi --max 0
pidgen-worker capacity set prompts --min 1 --max 2
```

Each chosen agent gets its cap, `--max 0` switches off each agent you did not choose, and the
prompt pool runs from 1 up to the sum of the caps.

### Change a cap later

Set a new cap with the worker's capacity command; a running worker applies it without a restart.
The worker setup installed is in `~/.pidgen/worker/bin`, which is not on `PATH`, so run it by path
(or put that directory on `PATH`):

```sh
~/.pidgen/worker/bin/pidgen-worker capacity set claude --max 4
```

`--max 0` switches an agent off. To size the agents again with setup, run it with the new number or
plan, for example `pidgen setup --agent claude --sessions claude=4` or
`pidgen setup --agent claude --plan claude=max-20x`. On an enrolled worker, setup does
not enroll again; it applies the caps from that run's capacity step.
[Configure the worker](https://docs.pidgen.ai/worker/configure/) describes the prompt and script
pools.

### When a step fails

A failed step stops setup with one block and nothing else: what failed and why, the one fix, the
setup log, and where a re-run continues. A task that fails keeps the last ten lines of its output
from this run under its `■` line:

```text
■  Couldn't install pidgen-worker 2.11.0
│  error: Failed to download `pydantic-core==2.41.4`
│  Caused by: Request failed after 3 retries
│  Read uv's output (its last lines above, all of it in the setup log) and fix what it names.
│  Log: ~/.pidgen/logs/setup-2026-10-17T21-40-12.log
└  Run pidgen setup again to continue from here.
```

Declining to install uv:

```text
◇  uv installs the worker and isn't on this machine. Install it? · No
│
■  Setup stopped: the worker needs uv.
│  Install uv yourself: curl -LsSf https://astral.sh/uv/install.sh | sh
│  Log: ~/.pidgen/logs/setup-2026-10-17T21-40-12.log
└  Nothing was changed. Run pidgen setup again to continue from here.
```

A credential that cannot enroll workers stops at sign-in:

```text
◇  Signed in as sam@example.com · Acme · Member
│
■  You can't add workers to Acme: that needs an Owner or Administrator.
│  Ask one of them to run pidgen setup on this machine, or sign in with a
│  Personal API Token that can enroll workers:
│    pidgen auth login https://api.pidgen.ai --with-token --account ACC-EXAMPLE
│  Log: ~/.pidgen/logs/setup-2026-10-17T21-40-12.log
└  Nothing was installed. Run pidgen setup again to continue from here.
```

The JSON envelope (`--format json`) is unchanged: its error names the step, the command that
failed, and the fix, and ends with ``Run `pidgen setup` again to continue from here.`` Fix the
problem and run setup again: steps that are already done, such as the sign-in, the install and the
enrollment, are detected and skipped.

### The setup log

Each run of setup writes a log, `~/.pidgen/logs/setup-<start time>.log` (in `$PIDGEN_HOME/logs` when
that is set), readable only by you (mode 0600). It holds what the screen leaves out: the CLI and
Node.js versions, the server, the flags, each step's start, end and result, every command setup ran
with its full output, each question and answer, and every error in full. It never holds a token, an
enrollment token or another credential: they are written as `[redacted]`. Setup keeps the newest
ten setup logs and removes older ones. The worker's own log stays where the worker writes it,
`~/.pidgen/logs/worker-manager.log`.

To watch the commands and their output as setup runs, add `--verbose`: each task then shows its
commands and their output under it, and keeps them on screen after it succeeds.

```text
◒  Installing pidgen-worker 2.11.0…
│  $ pidgen worker install --runtime wheel
│  $ uv tool install --python 3.12 ~/.pidgen/worker/.staging-…/pidgen_worker-2.11.0-…whl
│    Resolved 45 packages in 320ms
│  $ pidgen worker verify
│    ok    digest      sha256:955a7be3…
│
◇  pidgen-worker 2.11.0 installed and verified
```

### The name question

Before it creates an enrollment, setup always asks for the worker's name, unless `--label` answers
it in advance. The name is the enrollment's label and the worker's name in the Account, its
`display_name`, which `pidgen worker status` and the web app show beside the worker's id. Pidgen
gives every new worker an id of its own, `wkr_` and 26 characters, whatever the machine is called;
the worker saves it in `worker.env` (`PIDGEN_LOCALITY_DOMAIN`) and connects as it, and setup waits
for that id to connect. Setup shows the worker as its name with its id:
`Enrolled as my-host (wkr_…) in Acme`, then `Worker running and connected to Pidgen as my-host (wkr_…)`.

```text
◆  Worker name
│  my-host
└
```

The suggestion filled in is:

- this install's newest worker's name, when the Account lists it as removed: the worker whose
  `install_id` is this install's id ([below](#what-setup-keeps-and-sends)), since the Account may
  reclaim its name;
- this machine's removed worker's name, when this install's `worker.env` names a worker the Account
  lists as removed;
- else this machine's host name;
- else, when a live worker of the Account already holds the host name, the next free name
  (`my-host-2`, then `my-host-3`).

Press Enter to accept it, or type another name. The question stays open, saying why, on a name that
is empty, longer than 100 characters, or held by a live worker of the Account (names are compared
with each worker's name, without regard to case, and with its id only for a worker enrolled before
workers had names). Nothing is created until you answer, and the answer is shown as
`◇  Worker name · my-host`. The setup log records the suggestion and why it was chosen.

Setup cannot see every name that is taken: another person's pending enrollments in the Account are
not visible to it. When the App Service refuses the enrollment because the Account holds the name,
by a live worker or a pending enrollment (`409` with `WORKER_NAME_TAKEN`), no enrollment was
created. Setup says so in one line, `▲  my-host is taken in Pidgen, so this worker needs another
name.`, and asks `Worker name` again with the name the server suggests
(`error.details.suggested_name`) filled in, then enrolls under your answer. With `--label`, setup
never asks: a `--label` the Account already lists, or one the server refuses with
`WORKER_NAME_TAKEN`, stops setup at the enroll step, exit 5 with `WORKER_NAME_TAKEN`, in one block
whose fix is `pidgen setup --label <suggested name>`; nothing is created or started.

### How setup knows this machine is enrolled

Setup decides from this install's worker home (`~/.pidgen`, or `$PIDGEN_HOME`). The machine is
enrolled only when the home's `worker.env`, which `pidgen-worker enroll` writes, holds a credential
for the server setup signs in to, and the Account lists that worker, by the id in `worker.env`
(`PIDGEN_LOCALITY_DOMAIN`), without revoking it. Setup reads `worker.env` only to learn whether the credential is
there; it never prints or stores it.

- **This install's worker is listed, but its credential is missing.** The Account lists a live
  worker under this install's id, and this worker home holds no credential for it (`worker.env` was
  deleted or moved). Setup does not enroll a second worker beside it. It says
  `This install's worker my-host is still listed but its credential is missing.` and asks
  `Replace my-host?`. Yes: remove the worker on the Workers page, then answer yes to
  `Removed my-host on the Workers page?`; setup reads the Account's list again each time, says so
  while it still lists the worker live, and once it lists it as removed asks `Worker name` with
  `my-host` filled in and enrolls this install under it. No, at either question: the name question
  suggests a new name (`my-host-2`). `--label` answers the name in advance and asks nothing.
- **Another worker already has this machine's name.** When the Account lists a worker under this
  machine's host name that is not this install's (its `install_id` is another install's, or it has
  none), for example one that keeps its settings in
  another folder, setup does not adopt it. It says so, and the name question suggests the next free
  name (`my-host-2`, then `my-host-3`); setup enrolls under your answer. `--label` answers the
  question in advance.
- **The worker was removed.** When the Account lists this home's worker as revoked, or no longer
  lists it, setup asks whether to enroll it again (the default is yes), then the name question,
  suggesting the removed worker's name when the Account lists it as removed. Yes runs
  `pidgen worker enroll --replace-credential`: the removed worker's `worker.env` is moved aside to
  `worker.env.replaced-<UTC timestamp>` in the same folder (the setup log records its new path), so
  `pidgen-worker` redeems the new enrollment instead of starting with the revoked credential, and
  the worker starts and connects with its new one. The moved file is kept, never deleted.
- **Pidgen refuses the name.** A name can be taken where the Account's list cannot show it: by a
  worker of another Account (host ids are unique across Accounts), or by this Account's removed
  worker on a server that does not yet let an Account reclaim its name. `pidgen-worker enroll` is
  then refused with `HTTP 409 WORKER_HOST_TAKEN`, and setup says so in one line,
  `▲  my-host is taken in Pidgen, so this worker needs another name.`, asks `Worker name` again,
  defaulting to the next free one (`my-host-2`, then `my-host-3`), and enrolls under your answer, offering the
  same enrollment again (the server leaves it unspent), then goes on to start the worker. Should the
  same enrollment fail under the new name, setup withdraws it and makes one new enrollment, and the
  setup log names the one it withdrew. With `--label`, setup stops at the enroll step instead, exit 5 with
  `WORKER_HOST_TAKEN`, in one block naming the taken name and the fix,
  `pidgen setup --label my-host-2`; nothing is started. A removed worker is still offered its own
  name first, since the App Service accepts re-enrolling it; setup falls back only when the server
  refuses it.
- **The credential is for another server.** When `worker.env` holds a credential for another
  Pidgen server (or names none), setup stops at the enroll step before creating any enrollment,
  with `WORKER_CREDENTIAL_PRESENT` naming the file and that server. Move the file aside and run
  setup again to enroll this machine with this server, or run setup with another `PIDGEN_HOME`
  to keep it.
- **A Personal API Token cannot read the worker list.** Then the home's credential alone decides,
  and setup cannot confirm the worker connected.

Setup never starts a worker whose home holds no credential: it stops with
`ENROLL_FAILED` and asks you to report it with `pidgen feedback --kind not-working`.

A run that fails after it created an enrollment, because `pidgen-worker enroll` failed or the name
was refused with `--label`, withdraws that enrollment before it stops
(`DELETE /api/v1/workers/enrollments/{enrollment_id}`), so it does not wait for 24 hours holding a
worker slot. The step's fix says `The enrollment setup created was withdrawn, so nothing is left
waiting.`, and `error.details.withdrawn` is `true`. When the withdraw fails, setup notes it in its
log, the fix says the unused enrollment expires on its own, and the failure is reported as it was.

### What setup keeps and sends

Besides what each step's command keeps (the profile, the installed worker, its credential and
logs), setup keeps one file of its own in the worker home: `install-id` (`~/.pidgen/install-id`,
or `$PIDGEN_HOME/install-id`), this install's id, one line of 32 lowercase hex characters from 16
random bytes, made when it is absent and never overwritten. `pidgen-worker` keeps the same file;
whichever runs first makes it. It is not a credential and is never derived from this machine's
hardware: a second worker home on the same machine has its own id. A file that holds anything else
is left as it is, the setup log notes it, and no id is sent.

What the CLI sends the App Service about this install, when it creates an enrollment: the worker's
name (`label`) and this install's id (`install_id`). With the id the App Service replaces this
install's earlier pending enrollment instead of keeping both, and lists the worker with it, so setup
recognises this install's worker even after its `worker.env` is gone. A server from before install
ids refuses the field (`422`); setup then enrolls without it. The id goes only to the configured
Pidgen server.

## 2. Confirm the worker is ready

```sh
pidgen worker status
pidgen worker doctor
```

In the status result, check the following; with `--format json` they are these fields:

- `data.running` is `true`: the recorded worker process is running locally.
- `data.server.enrolled` is `true`: the Account recognizes this machine's worker.
- `data.server.worker.connected` is `true`: Pidgen reports a connection.
- `data.server.worker.revoked_at` is `null` and its `protocol_state` is `current` or `outdated`:
  the credential has not been revoked and its protocol is still accepted. Update an outdated worker.

Status can succeed while reporting a stopped worker or a server warning. Read those fields and its
warnings (`data.warnings`), not just whether the command succeeded. The server view requires a CLI credential for an Account Owner
or Administrator; a Personal API Token cannot read it. Ask an Owner or Administrator to confirm
the connection when your credential cannot, and use worker diagnostics to check the local setup.

The worker's diagnostics should pass. For a project's work to execute, its coding agent and
repository access must also be ready; inspect diagnostic fixes and the server's
[`git_credentials` report](workers.md#the-app-services-view) for missing repository credentials.
A connected worker alone does not prove that a ticket has run or delivered a change.

What runs on the machine is documented by the worker itself: set its capacity and pool sizes in
[Configure the worker](https://docs.pidgen.ai/worker/configure/), and prepare coding agents and
their subscriptions in [Coding agents](https://docs.pidgen.ai/worker/coding-agents/).

## Use separate commands for automation

`pidgen setup` requires a terminal even when you supply its flags. Coding agents and scripts
should use the individual commands. These do not install anything but the worker: `uv` and the
coding agents must already be on `PATH` (follow the
[uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/)). After
[authenticating](authentication.md), run these steps in order, checking each result before
proceeding:

```sh
pidgen doctor
pidgen worker install --runtime wheel
pidgen worker verify
```

The worker is installed in its own uv tool environment in the worker home
(`~/.pidgen/worker/bin/pidgen-worker`, the install result's `data.location`), never in uv's shared
tool slot, so it cannot replace a `pidgen-worker` installed some other way, or one that is running.
`pidgen worker` commands run it by that path, so it need not be on `PATH`. To run `pidgen-worker`
by name, as the capacity commands below do, put its directory on `PATH` first:

```sh
export PATH="$HOME/.pidgen/worker/bin:$PATH"
```

Then:

```sh
pidgen worker enroll --no-install --label development-worker
pidgen-worker capacity set claude --max 2
pidgen-worker capacity set codex --max 0
pidgen-worker capacity set pi --max 0
pidgen-worker capacity set prompts --min 1 --max 2
pidgen worker start --detach
pidgen worker status
pidgen worker doctor
```

Size the caps from [Plans and session caps](#plans-and-session-caps); the example is Claude Code on
Max 5x alone. A person signs in to each coding agent with `pidgen worker login claude` or
`pidgen worker login codex` before the worker runs it.

Enrollment creates the worker enrollment immediately and does not start it. When the worker home
already holds a credential, `pidgen worker enroll` refuses with `WORKER_CREDENTIAL_PRESENT` (exit 5)
and creates nothing: run `pidgen worker start --detach` to use the saved credential, or add
`--replace-credential` to move `worker.env` aside and enroll anew. When Pidgen refuses the worker's
host id because another worker holds it, `pidgen worker enroll` exits 5 with `WORKER_HOST_TAKEN`
and the refused name in `error.details.host_id`: enroll again under another name with
`--label <name> -- --host-id <name>`. When the App Service refuses the enrollment's name because
the Account holds it, by a live worker or a pending enrollment, `pidgen worker enroll` creates
nothing and exits 5 with `WORKER_NAME_TAKEN`, the refused name in `error.details.display_name` and
the name the server suggests in `error.details.suggested_name`: enroll again under that one with
`--label <suggested_name> -- --host-id <suggested_name>`. Background startup
checks that the process stays alive for two seconds; it does not wait for the server connection.
Check status again until the server reports it connected. See [Worker reference](workers.md)
for enrollment failures, lifecycle behavior, and automation details.

## Restrict the models this machine runs

Which models exist and which accept images is decided in the App Service's setup flow, where your
Account chooses its model list, not on the worker. The shipped `worker-policy.yaml` restricts
nothing, so a harness runs every model Pidgen sends it. To keep a coding agent on this machine to
some models, or away from others, edit its `harnesses.<name>.models` block in the
[worker policy](worker-policy.md#location-and-structure). It is the only model setting on a worker.

The block holds two lists, `allow` and `deny`, both empty by default:

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

Keep the rest of the file as it is, then restart the worker (`pidgen worker restart`) so the change
takes effect. Adding a model to `allow` does not make it available: a model your Account's list
does not offer still never reaches this machine.

## Operate your worker

| Task | Command |
|---|---|
| Inspect status and update availability | `pidgen worker status` |
| Check the worker's own configuration | `pidgen worker doctor` |
| Stop the background worker | `pidgen worker stop` |
| Start it again | `pidgen worker start --detach` |
| Restart it with the arguments it was started with | `pidgen worker restart` |
| Install an update and restart | `pidgen worker update --restart` |

Updates happen when you request them. A detached worker runs in the background; automatic startup
after a machine reboot is not configured by these commands. Start it again after rebooting, or
run the worker under a service manager as described in
[Run as a service](https://docs.pidgen.ai/worker/run-as-a-service/).

The worker's own documentation covers the rest of operating it on this machine:
[Configure the worker](https://docs.pidgen.ai/worker/configure/) for capacity and pool sizes,
[Coding agents](https://docs.pidgen.ai/worker/coding-agents/) for harnesses and subscriptions, and
[Worker troubleshooting codes](https://docs.pidgen.ai/worker/troubleshooting/) for problems the
worker reports.

For installation or connection problems with the CLI commands, use
[Worker troubleshooting](troubleshooting.md#workers).
Next: [Install agent skills](install-skills.md), including the worker setup skill, or
[create your first ticket](getting-started.md#create-your-first-ticket).
