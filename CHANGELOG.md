# Changelog

## Unreleased

## 0.1.0-alpha.5

The fifth alpha, published to npm under `alpha` and `latest`. `pidgen ticket show` and
`pidgen ticket actions` explain a failed step with the App Service's failure projection, the
worker setup skill and install guide describe model restrictions, and everything the CLI prints
about an Epic in a domain says Initiative.

### pidgen says Initiative for a Domain Epic

- Everything the CLI prints for a person about an Epic in a domain says **Initiative**:
  `pidgen domain epics` heads its output `Initiatives`, `pidgen ticket create --domain` and
  `pidgen epic create --domain` confirm `Initiative <key> created.`, their help says Initiative, and
  the CLI's own refusals of an Initiative's file say so. A terminal shows a sentence about the
  Initiative after the server's message for `PARENT_OUTSIDE_DOMAIN`, `DOMAIN_HAS_NO_PROJECTS`,
  `DOMAIN_PROJECT_CONFLICT`, `DOMAIN_HAS_OPEN_EPICS` and `DOMAIN_COVERAGE_IN_USE`.
- The `pidgen-manage-epics` and `pidgen-decompose-plan` skills say Initiative, defined as an Epic
  filed in a domain rather than a project.
- Command names, flags, error codes, exit codes and JSON output are unchanged.

### The worker setup skill and install guide describe model restrictions

- `pidgen-setup-worker` and [Install and connect a worker](docs/install-worker.md#restrict-the-models-this-machine-runs)
  document the worker policy's `harnesses.<name>.models` `allow` and `deny` lists (empty by
  default, `deny` wins, `*` globs, Pi entries as `provider/model-id`) as a worker's only model
  setting. Which models exist and accept images is the Account's model list, chosen in the App
  Service's setup flow; the skill no longer mentions a vision table or a worker-side fallback model.

### `pidgen ticket show` and `ticket actions` explain a failed step

- When a ticket's step failed and the App Service sends its failure projection,
  `pidgen ticket show` prints what happened, what fixes it and who can do it, with git's masked
  excerpt under "Technical details", and `pidgen ticket actions` names the recommended action
  first. `--format json` carries the projection unchanged (`data.failure` for `ticket actions`).
  A ticket without one, as from an older App Service, prints as before.

## 0.1.0-alpha.4

The fourth alpha, published to npm under `alpha` and `latest`. Its focus is getting a repository
ready for Pidgen and keeping a worker running: `pidgen project inspect`, `setup`, `rehearse` and
`doctor` with the `pidgen-project-readiness` and `pidgen-setup-workspace` skills, and
`pidgen worker restart`. `pidgen setup` asks the worker's name, recovers from a taken name, a
removed worker or an enrollment it cannot use, and offers a newer worker release on every run.
`doctor` and setup require git 2.38 or later, and the CLI says when `pidgen-worker` on `PATH` is
not the worker it installed.

### The CLI says when `pidgen-worker` by name is not the worker it installed

- After a wheel `pidgen worker install` or `pidgen worker update` (and the install in
  `pidgen worker enroll --install` and `pidgen setup`), one line on standard error says when
  running `pidgen-worker` by name no longer reaches the installed worker, with the
  `export PATH=…` line for `~/.pidgen/worker/bin`: when another `pidgen-worker` is first on
  `PATH`, which the CLI neither runs nor updates, or when the update removed an earlier CLI's
  install from `~/.local/bin`, so `pidgen-worker` is no longer on `PATH`. JSON envelopes and exit
  codes are unchanged.
- `pidgen doctor`'s `worker` check names another `pidgen-worker` first on `PATH`; a `current`
  install with one is `warn`, with the `export PATH=…` line as its fix.

### Documentation-led worker support in `pidgen-setup-worker`

- The worker skill now routes setup diagnosis, new model and coding-agent readiness, capacity,
  harness options and multiple subscriptions to the relevant pages at `https://docs.pidgen.ai`.
  It checks installed versions and help, distinguishes local readiness from server/model support,
  and reports undocumented options instead of inventing configuration keys or commands.
- Configuration guidance verifies saved versus applied changes, preserves unrelated settings,
  accounts for service environments and executable mismatches, and explains subscription
  entitlement, duplicate logins and unknown login state. Support feedback is sent only when asked.
- New user guides cover model readiness, selecting a newer Claude executable, model input
  capabilities, and the complete worker 2.11.1 policy keys with constraints and shipped example
  values. They are based on the public release's schema and example, and distinguish local
  settings from application model selection. Both are included in documentation navigation.
- Refresh installed copies with `pidgen skills install` after upgrading the CLI. This is a skill
  contract change; CLI commands, envelopes and exit codes are unchanged.

### `pidgen-setup-workspace` skill: make a repository's tests pass in isolated workspaces

- A new bundled skill, `pidgen-setup-workspace`, takes a repository from tests that pass on a
  developer machine but fail in Pidgen to a tracked `pidgen.toml` with `provision`, `activate` and
  `teardown` hooks. It lists what the tests need from CI and test configuration, gives each
  workspace its own services (a Compose project per workspace, or a namespace on a shared server),
  ports, installs, settings and secrets, names everything after the workspace, and rehearses the
  hooks in fresh checkouts with the environment a worker gives them: idempotent `provision`,
  `activate` that survives a changed lockfile, two workspaces at once, and `teardown` on a
  half-built slice. It reads the Project with `pidgen project show` and diagnoses a failed run's
  hook errors with `pidgen run list`, `show` and `node-output`.

### `pidgen worker status` after `pidgen worker uninstall`

- With no install record, `pidgen worker status` now says so: in a terminal it starts with
  `Worker not installed.` and names `pidgen worker install`, and when the App Service still lists
  this machine as enrolled it says the enrollment and the worker's credential were kept because
  `--purge` was not given. It still exits 0. `data` gains `installed` (`true` with a valid install
  record, `false` without); the other fields are unchanged.
- `pidgen worker uninstall` also removes a stale detached run record, so `worker status` no longer
  shows a leftover worker process after uninstalling.

### `pidgen project doctor` and the `pidgen-project-readiness` skill

- New command, `pidgen project doctor <key> [--since <n>d] [--propose-fix] [--json]`: asks whether
  the workspace setup is why work in the Project fails (`POST …/readiness/doctor`). A terminal
  shows the frame's title, one line per group of checks (setup files, workers, secrets, workspaces
  and tests in the window, drift since the last rehearsal) with the failures beneath by Ticket
  key, then the verdict line, its sentence and the fix. When the setup is the problem it exits 1
  with `SETUP_IS_THE_PROBLEM`, the report in `error.details.report`; the other verdicts, `code`
  and `unclear` (the doctor cannot tell), exit 0. `--since` widens the 7-day
  window, `--propose-fix` opens the fix as a pull request when the doctor has a template for it,
  and `--json` prints the server's report unchanged for scripts.
- New skill, `pidgen-project-readiness`: teaches an agent `pidgen project inspect`, `setup`,
  `rehearse` and `doctor`, asking the person before anything that writes. `pidgen-setup-worker`
  points to it once the worker runs.
- The pending fragment `contracts/pending/project-readiness.json` adds the doctor route and its
  report.

### `pidgen project inspect`, `project setup` and `project rehearse`

- New command, `pidgen project inspect <key>`: the Project's readiness, what its repository needs
  before a Ticket can work in it. A terminal shows one row per area (checkout, tools on the worker,
  dependencies, services, database setup, tests, CI, secrets and data) with its state word (ok,
  proposed, needs you, cannot tell, pending) and summary, then each open question with its
  evidence and the `--answer <id>=<value>` that answers it and inspects the repository again.
  `data` is the server's readiness unchanged.
- New command, `pidgen project setup <key>`: shows the proposed setup (`.pidgen/pidgen.toml` and
  the scripts it names) and writes nothing. `--write` extracts the proposed files under `.pidgen/`
  at the root of the current git checkout, each file 0644 or 0755 as proposed, and refuses to
  change an existing `.pidgen/` (`FILES_EXIST`, exit 5) unless `--force`; writing the same
  proposal again changes nothing; an archive with a path
  outside `.pidgen/` or a link is refused whole (`ARCHIVE_INVALID`, exit 1). `--pull-request`
  opens the pull request that proposes them through the Project's forge.
- New command, `pidgen project rehearse <key> [--ref <branch>] [--no-follow]`: asks a worker to
  rehearse the setup in a throwaway workspace and follows it, printing each step as it is reported
  and the verdict last. A failed rehearsal exits 1 with `REHEARSAL_FAILED`.
- The readiness routes are agreed with the App Service and not yet published; the CLI is built
  against a pending fragment, `contracts/pending/project-readiness.json`
  ([API compatibility](docs/api-compatibility.md#project-readiness)).

### git 2.38 or later, with the command that installs it on each system

- `pidgen doctor`'s `git` check, and so `pidgen setup`'s "Check this machine" step, now needs git
  2.38 or later (it was 2.25): git 2.37 fails, 2.38 passes, and versions compare numerically (2.100
  is newer than 2.38). The summaries say "2.38 or later" and "older than 2.38".
- The fix names a working command for the system, and differs for a missing and a too old git where
  the commands do. On macOS: `xcode-select --install` or `brew install git` when git is missing;
  `brew install git` (Homebrew's git before `/usr/bin` on `PATH`) or updating the Command Line Tools
  through Software Update when it is old. On Linux, from `/etc/os-release` (`ID`, then each
  `ID_LIKE` entry), read only when the check fails: the git-core PPA on Ubuntu, Linux Mint and Pop!_OS
  (Ubuntu 22.04's own git is 2.34); `apt` on Debian, noting that Debian 12 or later packages a new
  enough git; `sudo dnf install git` / `sudo dnf upgrade git` on Fedora, RHEL, CentOS Stream, Rocky,
  AlmaLinux and Amazon Linux; `sudo pacman -S git` on Arch and Manjaro; `sudo apk add git` /
  `sudo apk upgrade git` on Alpine; `sudo zypper install git` on openSUSE and SLES; otherwise
  "install git 2.38 or later with your package manager: https://git-scm.com/downloads/linux".
- `--format json` keeps its shape: `fix` is still one string per check, and a failing `git` check
  still exits 1 with `DOCTOR_FAILED`.
- Docs: [Install a worker](docs/install-worker.md) lists the command for each system;
  [Getting started](docs/getting-started.md) and the doctor table in [Commands](docs/commands.md)
  say 2.38.
- The `pidgen-setup-worker` skill says setup stops for a git older than 2.38 and that the `git`
  check's fix names the command for the person's system.

### `pidgen worker restart`

- New command, `pidgen worker restart [--force]`: stops the detached worker (or the
  `pidgen-worker` container) as `worker stop` does and starts it detached again with the arguments
  it was started with (its run record, or the container's `ai.pidgen.worker.args` label), with the
  startup check of `worker start --detach`. `data` is `stopped`, `record` and `running: true`.
  Nothing running exits 4 with `WORKER_NOT_RUNNING`, a worker that does not stop within
  `--timeout` exits 8 with `TIMEOUT` and is left running (`--force` kills it and continues), and a
  new worker that exits at once exits 1 with `WORKER_EXITED`. It takes no `-- args`.
- `pidgen worker update --restart` restarts the worker with the same shared step; its behaviour is
  unchanged.
- Skill: `pidgen-setup-worker` restarts the worker after an environment change with
  `pidgen worker restart` instead of a stop and a start.

### One setup test per enrollment state, and troubleshooting for the ones a person can meet

- Docs: [Troubleshooting](docs/troubleshooting.md#enrollment-states) explains the enrollment states
  a person can meet when setting up a worker (rows 3, 4, 6, 7, 10, 11 and 13 of the enrollment
  state table), each with the command that fixes it, among them a worker home copied from another
  machine.
- Tests: `pidgen setup`'s tests now have one test per row of the state table, rows 1 to 12
  (`enrollment states`), against a fake `pidgen-worker` that follows the worker's saved-credential
  rules, written beside it. No command changed.

### Setup recognises this install's worker and withdraws an enrollment it cannot use

- `pidgen setup` and `pidgen worker enroll` now keep a random id for this install in the worker
  home, `$PIDGEN_HOME/install-id` (default `~/.pidgen/install-id`): one line of 32 lowercase hex
  characters from 16 random bytes, created when absent and never overwritten, never derived from
  the machine, and not a credential. `pidgen-worker` keeps the same file. Moving `worker.env` aside
  leaves it alone. A file holding anything else is left as it is, with a note, and no id is sent.
- Both send it as `install_id` on `POST /api/v1/workers/enrollments`, so the App Service replaces
  this install's earlier pending enrollment instead of keeping both. `worker enroll`'s `data` names
  it in `install_id`. A server from before the field refuses it with `422` naming `install_id`; the
  create is then sent once more without it, and `data.install_id` is `null`.
- Setup recognises this install's worker by its id in `GET /api/v1/workers`, even with
  `worker.env` gone. When it is listed live and this home has no credential for it, setup says
  `This install's worker <name> is still listed but its credential is missing.` and asks
  `Replace <name>?` instead of enrolling a second worker: yes asks the person to remove it on the
  Workers page and continues under that name once the list, read again, shows it removed; no
  suggests a new name. When it is listed removed, the name question suggests its name (the newest
  one's).
- A run that fails after creating an enrollment withdraws it before exiting
  (`DELETE /api/v1/workers/enrollments/{enrollment_id}`), so it no longer waits for 24 hours holding
  a worker slot: `ENROLL_FAILED`, `WORKER_HOST_TAKEN` and any other failure keep their code and exit
  code, with `error.details.withdrawn: true` and a message ending `The enrollment <id> was
  withdrawn.` A failed withdraw is a note: `withdrawn: false` and `error.details.withdraw_error`.
  Setup's fix and log say which.
- Contracts: the install id fields, the caller's enrollment list and the withdraw are agreed with
  the App Service but not yet published; they stand in as the pending fragment
  `contracts/pending/worker-enrollments.json`, with types in
  `src/generated/worker-enrollments.d.ts`, and the contract tests run Prism serving it.
- The `pidgen-setup-worker` skill describes the replace question and the withdrawn enrollment.
- Test notes: unit tests over a temporary home cover the file, its format and the request body on
  two runs (with `worker.env` moved aside), an invalid file, a stubbed `422` naming `install_id`
  (also a Prism contract test), setup with this install's worker listed live and listed removed, and
  a failing fake `pidgen-worker` asserting the `DELETE` and the envelope for both commands.

### Setup asks the worker's name before enrolling

- `pidgen setup` now always asks `Worker name` before it creates an enrollment, on a terminal and
  unless `--label` answers it, with a suggestion filled in that Enter accepts and the person may
  edit: the removed worker's name when this machine's `worker.env` names a worker the Account lists
  as removed, else this machine's host name, or the next free name (`<name>-2`, then `-3`) when a
  live worker of the Account holds it. Before, setup asked only when its own choice was taken, so
  the person never saw or chose the name. The question stays open on a name that is empty, over 100
  characters or held by a live worker of the Account; names are now compared without regard to
  case. The answer is shown as `◇  Worker name · <name>` (the question was `Name for this worker`),
  and the setup log records the suggestion and why it was chosen.
- New error code `WORKER_NAME_TAKEN` (exit 5): the App Service refuses
  `POST /workers/enrollments` with `409` when the Account holds the name by a live worker or a
  pending enrollment, which the CLI cannot always see. `pidgen worker enroll` reports it with the
  refused name in `error.details.display_name` and the server's suggestion in
  `error.details.suggested_name`; nothing was created, and it never asks. Setup meets it with
  `▲  <name> is taken in Pidgen, so this worker needs another name.` and asks `Worker name` again
  with the suggested name filled in. The CLI handles the refusal before the App Service returns it.
- A `--label` never asks. A taken one, listed by the Account or refused with `WORKER_NAME_TAKEN`,
  now stops setup with `WORKER_NAME_TAKEN`, exit 5, its fix `pidgen setup --label <suggested name>`;
  a `--label` the Account already listed used to stop with `CLI_USAGE`, exit 2.
- The `pidgen-setup-worker` skill describes the name question and `WORKER_NAME_TAKEN`.
- Test notes: unit tests cover the question on a fresh machine, with a live worker holding the host
  name and for a removed worker, an edited name, the local checks, a stubbed `409`
  `WORKER_NAME_TAKEN` for setup and for `pidgen worker enroll`, and a free and a taken `--label`.

### Setup recovers when Pidgen refuses the worker's name

- `pidgen worker enroll` now names the server's refusal of a taken host id. When
  `pidgen-worker enroll` exits 1 reporting `HTTP 409 WORKER_HOST_TAKEN`, the command exits 5 with
  the new code `WORKER_HOST_TAKEN` and the refused name in `error.details.host_id`, instead of
  `ENROLL_FAILED` with the worker's advice to remove the worker on the Workers page, which does not
  free the name. Other failures keep `ENROLL_FAILED`, exit 1. The worker's output still goes to
  standard error, now with the one-time token replaced by `[redacted]` there too.
- `pidgen setup` meets the refusal at its enroll step with one line,
  `▲  <name> is taken in Pidgen, so this worker needs another name.`, asks `Name for this worker`
  defaulting to the next free name (`<name>-2`, then `-3`, skipping names refused in the run), and
  enrolls under the answer, offering the same enrollment again (the server leaves its token
  unspent), then starts the worker as usual. Should the same enrollment fail under the new name,
  setup makes one new enrollment and the setup log names the unused one. A name can be taken where
  setup cannot see it: by a worker of another Account (host ids are unique across Accounts), or by
  this Account's removed worker on a server that does not yet let an Account reclaim its name.
- With `--label`, a refused name stops setup at the enroll step, exit 5 with `WORKER_HOST_TAKEN`, in
  one block naming the name and the fix `pidgen setup --label <next free name>`; nothing is
  started.
- Setup still offers a removed worker its own name first, since the App Service accepts
  re-enrolling it, and falls back only when the server refuses it.
- The `pidgen-setup-worker` skill describes `WORKER_HOST_TAKEN` and no longer advises removing the
  old worker in the web app.
- Test notes: unit tests cover the refusal and other failures of `pidgen worker enroll`, and setup's
  recovery (one enrollment, both runs with its token), a second refusal, a retried name, the
  new-enrollment fallback, the `--label` stop and the removed-worker case, with a fake
  `pidgen-worker` that prints the real refusal line. Manual check on the test bed: run
  `pidgen setup --label <a name another Account holds>`; it stops with `WORKER_HOST_TAKEN`, and
  without `--label` on a host whose name is taken it ends with the worker running under
  `<name>-2`.

### Setup offers a newer worker release on every run that starts the worker

- A part-done `pidgen setup` run (the worker installed but, say, not yet enrolled) used to skip the
  install step without comparing versions, so a machine set up minutes after a release started the
  older one. Before such a run starts the worker, setup now compares the installed version with the
  newest release on its track (the rule `pidgen worker update` follows: final releases, plus
  pre-releases while one is installed, never older) and, when one is newer, asks once,
  `pidgen-worker <new> is available (<old> installed). Update before starting?` (default yes). Yes
  asks the licence question for the new release, then runs `pidgen worker update --restart` and
  starts it; no starts the installed release and names `pidgen worker update`. `--accept-licence`
  answers both questions in advance; without a terminal setup still exits 2 with
  `TERMINAL_REQUIRED`.
- *Check everything and stop* on a finished machine now says
  `pidgen-worker <new> is available (<old> installed)` when a newer release is out, without asking
  or installing. The re-run menu is otherwise unchanged.

### Re-enrolling a removed worker uses the new enrollment

- `pidgen setup` on a machine whose worker was removed from the Account (listed revoked, or no
  longer listed) asks `Enroll it again?` as before, and now runs
  `pidgen worker enroll --replace-credential`: the removed worker's `$PIDGEN_HOME/worker.env` is
  moved aside to `worker.env.replaced-<UTC timestamp>` before the enrollment is created, so
  `pidgen-worker enroll` exchanges the new enrollment instead of keeping the revoked credential, and
  the worker starts and connects. Before, setup created an enrollment the worker never redeemed,
  and the worker's registration was refused. The setup log records the moved file's path.
- `pidgen worker enroll --replace-credential` is new. It renames an existing `worker.env` that
  holds a credential to `worker.env.replaced-<UTC timestamp>` in the same folder, mode 0600, just
  before creating the enrollment (putting it back if the server refuses the enrollment), and reports
  the new path in `data.replaced`. The CLI never reads the credential's value, prints it, returns it
  or deletes the file. With no `worker.env` the flag changes nothing.
- `pidgen worker enroll` without the flag now refuses a worker home whose `worker.env` already holds
  a credential: exit 5 with the new code `WORKER_CREDENTIAL_PRESENT`, before anything is installed
  or an enrollment is created. The message names the file and both ways on: `pidgen worker start` to
  use the saved credential, or `--replace-credential` to enroll anew.
- `pidgen setup` stops at the enroll step, before creating any enrollment, when `worker.env` holds a
  credential for another server (or one naming no server): `WORKER_CREDENTIAL_PRESENT`, exit 5, in
  one block naming the file and that server. It used to enroll anyway, and the worker kept the old
  credential.
- The `pidgen-setup-worker` skill describes the refusal and the flag.
- Test notes: unit tests cover the refusal, the move (path, mode, `data.replaced`, no credential on
  standard output, standard error or in the envelope), the no-file case, and setup's re-enroll and
  other-server paths with a fake `pidgen-worker` that, like the real one, skips the exchange when a
  credential is saved. Manual check on the test bed: after a completed setup, remove the worker on
  the Workers page and run `pidgen setup` again; it ends with the worker running and connected
  ([Troubleshooting](docs/troubleshooting.md#re-enroll-a-removed-worker)).

## 0.1.0-alpha.3

The third alpha, published to npm under `alpha` and `latest`. It publishes the changes listed under
0.1.0-alpha.2, which was tagged but never reached npm, with one test fix. Its focus is
`pidgen setup`: one action at a time from a fresh machine to a running worker, with the worker
installed in its own environment, a setup log, `--verbose`, a summary card at the end, and the
worker's licence linked before it is installed. `pidgen worker update` now follows a beta's
pre-release track and never moves backwards.

### A setup test no longer depends on the Node.js version that runs it

- The test of setup's whole first-run screen expected the check line to read `Node.js 24.16`, the
  version it was written on, so it failed on every other Node.js release, and 0.1.0-alpha.2's
  release run stopped before publishing. It now expects the running Node.js's `major.minor`, as
  the other setup output tests do. The CLI's behaviour is unchanged.

## 0.1.0-alpha.2

Tagged but not published to npm: its release run failed the setup test fixed in 0.1.0-alpha.3,
which publishes these changes. Its focus is `pidgen setup`: one action at a time from a fresh
machine to a running worker, with the worker installed in its own environment, a setup log,
`--verbose`, a summary card at the end, and the worker's licence linked before it is installed.
`pidgen worker update` now follows a beta's pre-release track and never moves backwards.

### Worker update never moves backwards and follows a beta's track

- `pidgen worker update` without `--version` no longer installs the server's newest final release
  whenever it differs from the installed one. It installs only a release newer than the installed
  version, by PEP 440 order: on a final release, a newer final release of the server's current
  series (pre-releases are ignored); on a pre-release installed with `--version` (`2.11.1b1`), a
  newer pre-release or final release of the series, the newest winning (`2.11.1b2`, then
  `2.11.1rc1`, then `2.11.1`). Once a final release is installed, later updates follow final
  releases only. A machine on `2.11.1b1` is no longer moved back to `2.11.0`.
- When nothing is newer, update installs nothing, prints no licence notice, exits 0 with
  `updated: false` and the install record, and in a terminal says the installed version is already
  the newest on its track. The JSON envelope's shape is unchanged.
- `--version` still installs exactly the release it names, older releases included.
- `pidgen setup`'s re-run menu offers *Update the worker to <version>* by the same rule, so a
  machine on a beta is offered the next beta and never an older release.

### The worker's licence is linked before it is installed

- `pidgen setup`'s install question now links the full text of the Pidgen Worker End-User Licence
  Agreement under the line that names it:
  `Read it: https://pidgen.ai/legal/eula`. With `--accept-licence` the screen still shows the one
  answered line; the setup log records the licence's lines under the question either way.
- The licence notice `pidgen worker install` and `pidgen worker update` print on standard error
  ends with the same `Read it: https://pidgen.ai/legal/eula` line. Standard output and the JSON
  envelope are unchanged.

### A closed pipe no longer crashes the CLI

- When whatever reads the CLI's standard output or standard error closes it early (for example
  `pidgen worker status --format json | head -c 100`, or a pipe into a program that is not
  installed), the CLI no longer crashes with an unhandled `EPIPE` and a Node.js stack trace. It
  stops writing and exits with the command's own exit code.

### Setup accepts the caps pidgen-worker 2.11 saves

- `pidgen setup` no longer stops at `enroll` with `CAPACITY_FAILED` ("exited with status 0") when
  `pidgen-worker capacity set` succeeds. pidgen-worker 2.11 prints the file's path and digest before
  its `saved` line, and setup read only the first line. Exit 0 with a `saved`, `saved (…)`,
  `saved, apply pending` or `saved; …` line anywhere in the output is now success; `saved (…)` is
  what the worker prints when the values were already set.

### Setup ends with a summary card, fails in one block, and asks what to do on a re-run

- **A summary card.** In a terminal, a successful `pidgen setup` ends with
  `└  Done in <m> min <s> s` and a card on standard output: the Account (by name, with your email),
  the worker's name, version and state, each coding agent's sessions, the commands to manage it
  (`pidgen worker status`, `pidgen worker stop`, `pidgen setup`), and the one next thing to do. The
  `Setup complete.` / `Steps (N displayed)` rendering of `data` is gone. With `--format json` the
  envelope is unchanged and the frame ends with the `└  Done in` line on standard error.
- **A failure is one block.** A failed step shows one `■` block: what failed and why, the one fix,
  the setup log's path and `Run pidgen setup again to continue from here.`, with nothing more: no
  `error <code>:` line, no `Details:`, no repeated message. Declining uv now prints five lines after
  the question instead of about sixty. The JSON envelope keeps every field.
- **Re-running a finished setup asks what to do.** `◇  Already set up · <Account> · <agents> ·
  pidgen-worker <version> · running`, then *Check everything and stop*, *Change coding agents or
  sessions*, or, when the server's current release is newer, *Update the worker to <version>*
  (`pidgen worker update --restart`). A part-done machine collapses what is done into one
  `◇  Already done · …` line and continues.
- **A credential that cannot enroll stops at sign-in.** Setup stops before anything is installed
  with `ENROLL_NOT_PERMITTED` (exit 3) at the `sign-in` step, naming the roles that can (an Owner
  or Administrator) and the Personal API Token sign-in command.
- **The sign-in block leads with the link.** `◆  Sign in to Pidgen`, then the link that carries the
  code (`verification_uri_complete`), then the address and the code, and a spinner until you
  approve.

### Setup shows only the action: the setup log, spinners and --verbose

- **Only the current action on screen.** While `pidgen setup` runs, the screen no longer shows the
  `$ pidgen …` lines or the output of uv, npm, uv's installer or the worker. Each task is a spinner
  that collapses to one line, such as `◇  pidgen-worker 2.11.0 installed and verified`,
  `◇  Enrolled as sams-laptop in Acme`, `◇  Worker running and connected to Pidgen` and
  `◇  Worker checks passed`; sign-in collapses to
  `◇  Signed in as <email> · <Account> · <Role>`, and each signed-in coding agent to
  `◇  <agent> signed in`.
- **The machine check is one line.** `◇  This machine is ready · Linux · Node.js 24.16 · git 2.43`;
  the checks a later step fixes, and the container runtime's `cosign` warning, go only to the log.
- **The setup log.** Each run writes `~/.pidgen/logs/setup-<start time>.log` (mode 0600) with the
  CLI and Node.js versions, the server, the flags, each step's start, end and result, every command
  and its full output, each question and answer, and every error in full. It never holds a token,
  enrollment token or other credential (they are written as `[redacted]`). Setup keeps the newest
  ten. A failed step's `error.details` adds `setup_log`, its path; a failing command's own `log` is kept.
- **`--verbose`** shows each task's commands and their output under it as it runs, and keeps them
  after it succeeds.
- **A failing task keeps its last ten lines.** Without `--verbose`, a task that fails keeps the last
  ten lines of its own output from this run on screen under its `■` line, each once, then the
  log's path.

### Setup asks its questions with clack: checkboxes, choices, sessions as a number

- **Prompts, not typed numbers.** Every question `pidgen setup` asks is a clack prompt answered with
  the arrow keys, space and Enter, drawn in clack's frame (`┌  Pidgen setup`). The
  `Step N of 8  <title>` headers and the `done` / `skipped — …` result lines are gone; each answered
  question collapses to one `◇` line, such as `◇  Coding agents · Claude Code, Codex`, and an
  answer a flag gave in advance is shown the same way with `(from --sessions)` and the like.
  `@clack/prompts` and `@clack/core` are new runtime dependencies, pinned exactly and loaded with a
  dynamic import only by setup, so no other command starts slower.
- **Coding agents are checkboxes.** Agents on `PATH` start ticked; a missing one is labelled
  `not installed · setup installs it with npm`, and ticking it installs it with no second
  question. Pi is shown, disabled, when it is on `PATH`. Confirming none keeps the question open
  with `Choose at least one.`
- **Sessions are a number.** Each chosen agent's question is
  `<agent>: how many sessions should run at once?`, a choice of numbers with plan hints (Claude
  Code 1, 2, 4; Codex 1, 2, 3) plus *Custom…*, a whole number from 1. It starts on the lowest, or
  on the worker's current cap on a re-run. New `--sessions <agent>=<n>` (repeatable) answers it in
  advance; `--plan` still does; both for one agent is `CLI_USAGE`. `data.steps`' `capacity.plans`
  now lists only the agents `--plan` answered for.
- **One install question.** `Install pidgen-worker <version> and accept its licence?`, with one
  line naming the licence, replaces the runtime question (setup offers only the wheel, so nothing
  is asked) and the licence notice, which setup no longer prints. New `--accept-licence` answers
  it; declining stops with `SETUP_CANCELLED` (exit 2): the worker wasn't installed.
- **Ctrl-C cancels cleanly.** Ctrl-C at any question stops setup with
  `Setup cancelled. Everything before this is kept.`, `SETUP_CANCELLED`, exit 2.
- **Failures name the step without a number.** A failed step's message is
  `Setup stopped at <title>…` and ends with ``Run `pidgen setup` again to continue from here.``
- **Skill contract change.** `pidgen-setup-worker` leads with `--sessions` for sizing agents and
  describes the prompts, `--accept-licence` and `SETUP_CANCELLED`.

### The worker is installed in its own environment, and the CLI runs the worker it installed

- **Its own uv environment.** `pidgen worker install --runtime wheel` (and so `pidgen setup` and
  `pidgen worker enroll --install`) runs `uv tool install` with `UV_TOOL_DIR` and
  `UV_TOOL_BIN_DIR` under the worker home (`~/.pidgen/worker/tools`, `~/.pidgen/worker/bin`), so it
  never replaces the `pidgen-worker` in uv's shared tool slot, whether another install put it there
  or a worker is running from it. uv's shared tool directory and `~/.local/bin` are left untouched.
  The install record's `location` is `~/.pidgen/worker/bin/pidgen-worker`.
- **The recorded worker runs.** Every `pidgen worker` command and setup run the `pidgen-worker` the
  install record names; `PIDGEN_WORKER_BIN` still wins, and `PATH` is searched only when there is
  no record. A recorded worker that is missing is `WORKER_NOT_FOUND` with its path in
  `error.details.location`, never another one on `PATH`. `pidgen-worker` is no longer on `PATH` by
  name after an install: run `~/.pidgen/worker/bin/pidgen-worker`, or put that directory on `PATH`.
- **Earlier installs keep working.** A record an earlier CLI made (in uv's shared slot) is still
  run. `pidgen worker update` installs into the new environment and moves the record there, then
  removes the earlier tool unless a worker is running from it or the slot now holds another
  install's. `pidgen worker uninstall` removes only what the record names.
- **Setup leaves another `pidgen-worker` alone.** When uv's shared slot holds a `pidgen-worker` the
  install record does not name, setup says so in one `▲` warning line and leaves it in place.

### Setup decides enrollment from this machine and never starts a worker without a credential

- **Enrolled means this install's credential.** `pidgen setup` skips the enrollment only when this
  install's worker home (`$PIDGEN_HOME` or `~/.pidgen`) has a `worker.env` with
  `PIDGEN_NODE_TOKEN` for the configured server and `GET /workers` lists its host id unrevoked. A
  worker listed under this host's name that is not this install's is no longer adopted: setup says
  so and asks for a name, defaulting to the next free one (`<host>-2`, then `-3`). A Personal API
  Token, which cannot read the list, leaves the home's credential to decide.
- **The name is the worker's host id.** Setup runs `pidgen worker enroll --label <name> --
  --host-id <name>`, so `--label` names both the enrollment and the worker; a `--label` the
  Account already lists stops with `CLI_USAGE` (exit 2). `data.steps` reports the name as the
  `enroll` step's `host_id`.
- **A removed worker is enrolled again only on request.** When the Account lists this home's
  worker as revoked, setup asks whether to enroll it again (default yes); declining stops with
  `SETUP_CANCELLED` (exit 2).
- **No credential, no start.** Setup never runs `pidgen worker start` when the worker home holds no
  credential; it stops with `ENROLL_FAILED` (exit 1) and asks for a report with
  `pidgen feedback --kind not-working`.

### Setup sizes each coding agent from its plan

- **`pidgen setup` asks each chosen agent's plan.** Its `capacity` step turns the answer into the
  agent's concurrent-session cap and prints it: Claude Code Pro 1, Max 5x 2, Max 20x 4, API key,
  Team or Enterprise 2, Not sure 1; Codex Plus 1, Pro 3, Business or Enterprise 2, API key 2, Not
  sure 1. `--plan <agent>=<plan>` (repeatable, such as `--plan claude=max-5x`) answers in advance.
  `data.steps` reports `plans` and `caps`.
- **The caps are applied after enrollment.** The `enroll` step runs
  `pidgen-worker capacity set <agent> --max <cap>` for each chosen agent, `--max 0` for each other
  harness, and `pidgen-worker capacity set prompts --min 1 --max <sum>`; a refused edit stops it
  with `CAPACITY_REFUSED` (exit 1) and the worker's message. A re-run on an enrolled worker applies
  the caps of that run again without enrolling again.
- **The guides describe the eight steps.** docs/install-worker.md, docs/getting-started.md and the
  `pidgen-setup-worker` skill cover `--agent`, `--plan`, `pidgen worker login`, the plan table, and
  changing a cap later with `pidgen-worker capacity set`.

### Setup chooses, installs and signs in to coding agents

- **`pidgen setup` asks which coding agents the worker runs.** Its `agents` step lists Claude Code
  and Codex with the ones on `PATH` pre-checked (Pi is shown when found, never installed);
  `--agent claude` and `--agent codex` (repeatable) answer in advance. Nothing chosen stops with
  `AGENT_REQUIRED` and a fix naming `--agent`. A missing harness no longer stops the check step.
- **A chosen agent that is missing is installed on request**, with
  `npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`. When npm may not
  write its global directory (EACCES), setup prints the command to run and looks on `PATH` again
  once you press Enter; declining stops with `AGENT_NOT_FOUND` and the command as its fix.
- **`pidgen worker login claude|codex`** runs the agent's own login with the terminal
  (`claude auth login`; `codex login --device-auth`), then its status command, and returns
  `{harness, login}` with `ready`, `not_ready` (exit 3, `AGENT_NOT_SIGNED_IN`) or `unknown`. Setup's
  `agent-login` step asks each chosen agent's status first and signs in only to those not ready.

### Numbered setup steps, a git check, and uv installed on request

- **`pidgen setup` shows eight numbered steps.** Each prints `Step N of 8  <title>` on standard
  error and a result line: `done`, `failed`, or `skipped — <reason>`. A successful run ends with
  `Done in <m> min <s> s` and the next action. `data.steps` adds the ids `agents`, `agent-login`
  and `capacity` between `sign-in` and `runtime`.
- **A failed step says where to continue.** Its message names the step and its fix and ends with
  ``Run `pidgen setup` again to continue from step N.``; `error.details.fix` ends the same way.
- **`pidgen doctor` checks git.** The `git` check, after `node`, fails when git is missing or older
  than 2.25, with `xcode-select --install` on macOS and "install git with your package manager" on
  Linux. `pidgen setup`'s check step runs it too.
- **Setup offers to install uv.** With uv missing, the check step asks `Install uv now?`; yes runs
  `curl -LsSf https://astral.sh/uv/install.sh | sh` and uses the uv it installed (from
  `~/.local/bin` until `PATH` has it); no stops with `RUNTIME_UNAVAILABLE` and that command as the
  fix.
- **The worker runs on a uv-managed Python.** The wheel installs with
  `uv tool install --python 3.12 --python-preference only-managed`, so a system Python, such as a
  python.org build on macOS without CA certificates, is never picked.

### Requests are named by their REQ key

- **`pidgen request` and `pidgen intent` print a Request's key, `REQ-{n}`, never its internal
  `conv-` id.** `request list`, `show` and every triage write print the key in `id` (and a
  duplicate's original by key in `duplicate_of`); the intent commands print it in
  `conversation_id` and `request_id`. The internal id appears only for a Request the server has
  not keyed. `request submit` prints the key and its page, `/requests/REQ-{n}?account=<account>`.
- **Every `<request>` and `<conversation>` argument takes the key**, sent to the server as given.
- **A promoted Request names its Ticket by `ticket_key`**, and `request promote` answers
  `ticket_key` beside `ticket_id`.
- The committed `contracts/openapi.json` states `request_key` and `duplicate_of_key` on `Request`,
  `ticket_key` on `RequestPromoted`, and `request_key` on the intent answers that name a request.
- Skills: `pidgen-triage-requests` and `pidgen-file-ticket` pass and report the `REQ-{n}` key.

### Worker pre-releases install from PyPI when named

- **`--version` installs an alpha, beta or release candidate from PyPI.** `pidgen setup`,
  `pidgen worker install` and `pidgen worker update` accept `--version X.Y.ZaN`, `X.Y.ZbN` or
  `X.Y.ZrcN`, verified like any release. Without `--version` they still take only final releases.
  Before, a pre-release on PyPI could not be installed at all, even by name.
- **A series with only pre-releases says so.** Its `RELEASE_UNSUPPORTED` names the newest
  pre-release in the message and in `error.details.pre_release` (`null` otherwise), the version
  `--version` would install.
- **Versions order as PEP 440 does:** development builds, then alphas, betas and release
  candidates, then the release. Before, `2.11.0a1`, `2.11.0b1` and `2.11.0rc1` ranked equal.

## 0.1.0-alpha.1

The first published release, an alpha, published to npm under the `alpha` dist-tag. Nothing was
published before it: changes marked breaking below are breaking only against earlier unpublished
builds. Install it with `npm install -g pidgen@alpha`. Until the first release, `latest` points at
the newest alpha too, so `npm install -g pidgen` installs the same version.

### The docs bundle for docs.pidgen.ai

- **`npm run docs:check`** (`scripts/docs-bundle.mjs check`) checks `docs/` against the docs bundle
  contract the docs site renders: every page but `README.md` listed once in `navigation.json` and
  every listed page present, each page titled by its `#` heading, relative links and `#anchors`
  resolving by GitHub's heading slugs, and no private material (internal citations, localhost or
  LAN addresses, `/home/` or `/srv/` paths, internal names, Account ids other than `ACC-EXAMPLE`,
  credentials). CI and the release workflow run it before the build.
- **`npm run docs:pack`** (`scripts/docs-bundle.mjs pack [dir] [--out <dir>]`) checks `docs/`, then
  writes the docs bundle `pidgen-cli-docs-<version>.tar.gz`: `docs-bundle.json` (format 1, product
  `cli`, the `package.json` version and the git commit), `navigation.json`, `README.md` and the pages
  it lists. Links that leave `docs/` (`../CONTRIBUTING.md`, `../skills`) point at the tagged public
  repository, `https://github.com/pidgen-ai/pidgen-cli/blob/v<version>/<path>`. The release workflow
  packs after `npm publish` and attaches the bundle to the tag's GitHub release, so docs.pidgen.ai
  can render the docs of the release people install.
- The worker guides ([Install and connect a worker](docs/install-worker.md),
  [Workers](docs/workers.md)) hand off to the worker's own docs for what runs on the machine:
  `https://docs.pidgen.ai/worker/configure/`, `/coding-agents/`, `/troubleshooting/` and
  `/run-as-a-service/`. The CLI pages keep install, enroll, start, stop, update and status.

### Token prefixes and documentation

- **`PIDGEN_TOKEN` recognises the `pidgen_cli_` and `pidgen_pat_` prefixes** the server issues, and
  still `awes_cli_` and `awes_pat_` for tokens issued before. A `pidgen_` token in `PIDGEN_TOKEN`
  was an unrecognised kind: `pidgen auth status` and `pidgen account list` did not ask the server
  who you are, and `pidgen doctor` and `pidgen setup` could not tell whether it may enroll workers.
- The rules for writing a skill move from `docs/skills.md` to `CONTRIBUTING.md`; `docs/skills.md`
  describes the bundled skills for the people who install them. `docs/api-compatibility.md` drops
  contributor detail, and the README's logo shows in light mode.
- `npm run api:coverage` attributes the contract create, publish and propose routes and the Request
  routes to the commands that send them.
- The README and docs install `pidgen@alpha`, and `pidgen doctor` suggests upgrading on the CLI's own
  channel (`npm install -g pidgen@alpha` from an alpha, `pidgen@latest` from a stable release).
- **Onboarding guides.** New guides take a person from installing the CLI to reading their
  Account's work (`docs/getting-started.md`), installing the agent skills (`install-skills.md`),
  setting up a worker (`install-worker.md`) and fixing common problems (`troubleshooting.md`). The
  docs index groups the pages into Getting started, Guides and Reference, with a navigation
  manifest (`docs/navigation.json`) for the website. The README introduces Pidgen to prospective
  customers and lists the bundled skills.

### Breaking: contract creation, contract publishing and Requests use the published routes

- **The last three pending fragments are gone.** The server publishes the contract creation,
  contract publishing and Request routes, so `contracts/openapi.json` is pulled again and
  `contracts/pending/contract-create.json`, `contract-publish.json` and `requests.json` and their
  generated types are deleted. `pidgen contract create`, `publish`, `propose` and `show` and every
  `pidgen request` command are typed from and validated against the published document. Built
  against the fragments, they would have refused the server's answers with `UNEXPECTED_RESPONSE`.
- **`pidgen contract publish`** answers the published `ContractPublishResult`: `outcome` (was
  `status`), `contract_id` and `contract_key` (was `contract`), `acceptance`, `change` as
  `additive` or `breaking` with `change_reason` (was `{kind, declared, why}`), the file's `format`,
  `version`, `title` and `source_path`, `operation_count`, `type_count`, `types_added`,
  `types_removed`, `still_pending` (was `pending`, a list of names) and `resolved_refusals`; there
  is no `source` or `refusal_id`. `--check` names the `change_reason` when it refuses a breaking
  change.
- **`pidgen contract propose`** answers `contract_id` and `contract_key` (was `contract`), the
  fragment's `format`, `version`, `title` and `operations`, beside `pending` and `landed`.
- **`pidgen contract propose` sends the files beside the fragment**, as `publish` does (every
  `.json`, `.yaml` and `.yml` file under its directory, or `--include <glob>`; at most 200 files and
  8 MiB), so a fragment's relative `$ref`s resolve instead of being refused with
  `CONTRACT_EXTERNAL_REF`. `pidgen contract create --schema` without `--existing` does the same and
  sends `--schema-format` as the proposal's `format`.
- **`pidgen contract show`** lists each operation's state in `operation_states` (`{name, state}`;
  was `operations`, with `implemented_by` and `removed_in`).
- **`pidgen request show`**: each timeline entry's `author` is `{actor, name, contact}`,
  `attachments` lists file ids and `files` the files; a Request's `requester`, `source` and
  `urgency` may be null.
- **`pidgen request close --reason`** takes one of `cannot_reproduce`, `wont_do`, `duplicate`,
  `invalid`, `answered`, `no_response`, `withdrawn` and `other`; another is `CLI_USAGE` (exit 2).
- **`pidgen request promote`** promotes into the Project the request targets: `--project` is
  optional and confirms it. `REQUEST_TARGET_NEEDS_PROJECT` now means the request does not target
  that Project, or targets a Domain or nothing.
- **Skill contract change:** `pidgen-manage-contracts` reads `outcome`, `change_reason`,
  `still_pending` and `operation_states`, and `pidgen-triage-requests` the timeline's `files`, the
  close reasons and promotion into the targeted Project. Run `pidgen skills install` to update
  installed copies.
- Contract tests now run against Prism serving the published document, including
  `pidgen contract publish` and `propose`.

- The CLI's copy of the public API contract (`contracts/openapi.json`) and its generated types no
  longer carry the retired legacy Epic routes (`/api/v1/epics`, `/api/v1/epics/{epic_id}`, its
  `dag` and `dag/edges`, and `POST /api/v1/tickets/{ticket_id}/epic`) or the schemas only they
  used, so `npm run api:coverage` no longer lists them. No `pidgen epic` command sent them: every
  one uses the ticket routes. `npm run contract:pull` leaves them out, and says so, while an App
  Service still publishes them. The Domain and Project Epic reads are unchanged.

### Output and presentation

- Authentication, Account, worker, setup and skill-status results now have labeled lifecycle
  summaries. Human failures retain supplied diagnostic checks, fixes, blocking findings and recovery
  actions; successful results retain warnings and incomplete contract/service checks. Subscription
  output retains connection, login errors and complete quota/pause observations beside summaries.
  Textual help/version, foreground worker handoff and established stderr streams are unchanged.
  Contributors can audit every registered operation in the presentation inventory in CONTRIBUTING.md.

- Mutation output explains unapplied previews and copyable application requirements, distinguishes
  settled changes from pending operations and timed-out waits, and retains created keys, promotion
  state, findings and recovery details. JSON responses and mutation safeguards are unchanged.

### Breaking: terminal output defaults

- **Breaking against earlier builds:** terminal stdout now defaults to human-readable
  responses. Nonterminal stdout (pipes, redirects and captures) continues to receive exactly one
  JSON envelope. Use `--format json` to retain JSON in automation in every environment;
  `--format table` explicitly selects human output. JSON fields, payloads, metadata, errors and exit
  codes remain unchanged, including usage failures. Help/version text and foreground worker streams
  keep their existing behavior.
- Resource reads identify collections and displayed counts, show compact identifying fields, and
  label details, prerequisites, findings, attempts, artifacts, evidence and long text. Narrow
  terminals use numbered records and wrapped prose while keeping actionable values complete.
  Paths containing spaces remain copyable inside arrays; installation summaries and preview
  guidance wrap prose without splitting destinations or application flags.
- Skill installation summarizes distinct skills, destinations, agents and installation records,
  lists outcomes by destination, and explains preserved locally edited copies.
- **Skill contract change:** all bundled skills explicitly request `--format json` for structured
  responses, including terminal examples. Run `pidgen skills install` to update installed copies.

### Skills: pidgen-manage-contracts publishes and proposes files

- **`pidgen-manage-contracts` is rewritten around `pidgen contract publish` and
  `pidgen contract propose`.** It chooses publish, propose, attach or link; never writes a schema
  into a command, a body or a ticket, passing file paths instead; runs `publish --check` first and
  stops to ask before publishing a breaking change; sets up CI (`.github/workflows/`,
  `.gitea/workflows/`, `.gitlab-ci.yml`) with publish on the default branch, `--check` on pull
  requests and the token as a secret; reads landed and pending operations; and lists every refusal
  code. It no longer teaches reading a schema into `pidgen contract create`.
- **`pidgen-decompose-plan`** says a root that builds against a pending operation builds against a
  mock. Run `pidgen skills install` again to update the installed copies.

### `pidgen contract publish` and `pidgen contract propose`: contracts enter as files

- **`pidgen contract publish <file> (--project | --domain)`** publishes a spec file, with every
  `.json`, `.yaml` and `.yml` file under its directory (or `--include <glob>`), as multipart. The
  contract is identified by its source path, by default the file's path relative to the repository
  root (`--path` overrides); `source_kind` is `ci` under `CI=true`, else `upload`; `--commit` and
  `--ref` name where it was read. It prints `created`, `revised` or `unchanged`, the change and why,
  and the operations added, removed, landed and still pending.
- **`--check`** is the dry run for pull requests: exit 0 when additive or unchanged, exit 5 with
  `CONTRACT_CHANGE_BREAKING` on a breaking change unless `--breaking` is given.
- **`pidgen contract propose <contract> <fragment>`** and **`--project <project> --title <title>
  <fragment>`** propose a revision, or a contract that does not exist yet, from a fragment file
  (`--check` for the dry run), and print which operations became pending and which were already
  landed.
- **A refused file** (`CONTRACT_FILE_INVALID`, `CONTRACT_FORMAT_UNSUPPORTED`,
  `CONTRACT_EXTERNAL_REF`, `CONTRACT_CONVERSION_TIMEOUT`, `FILE_TOO_LARGE`) exits 5 and prints every
  error with its location (`error.details.errors`).
- **Breaking: `pidgen contract create --schema <file>`** no longer reads the file into
  `native_schema`: with `--existing` it publishes the file, otherwise it proposes it as a new
  contract (with `--title`). `-f`, `--kind`, `--markdown` and `--owner` cannot be given with it.
- **`pidgen contract show`** lists each operation's state: `landed`, `pending` with its
  implementing ticket, or `removed`.
- **A pending fragment for publishing.** The routes are agreed with the App Service and not yet
  published: the CLI is built against `contracts/pending/contract-publish.json`, typed into
  `src/generated/contract-publish.d.ts`, until they are.

### Skills: pidgen-triage-requests, and pidgen-file-ticket files a request

- **A new bundled skill, `pidgen-triage-requests`,** works the request queue: `pidgen request list
  --state new`, `pidgen request show` (the request and its timeline), then `pidgen request
  acknowledge` or `pidgen request reply --ask`, `pidgen request accept` (`--priority`, and
  `--unknown` for a bug's missing details), `pidgen request close` (`--reason`, with
  `--duplicate-of` or `--note`) or `pidgen request promote --project`. `pidgen skills install`
  installs it with the others.
- **`pidgen-file-ticket` says when to file a request rather than a ticket:** someone outside the
  team asked, the work is not yet judged worth doing, or its target is unclear. It shows
  `pidgen request submit` with a bug's details (`--steps`, `--expected`, `--actual`) and evidence
  files (`--evidence`), and how to read `data.outcome` and `data.url`.

### `pidgen request`: submit, list, show and triage Requests

- **`pidgen request submit`** files a Request (`bug`, `feature`, `task` or `question`) from flags
  or `-f` (a JSON or YAML body, or a text file as the body): `--kind`, `--title`, `--body`,
  `--steps`, `--expected` and `--actual` (a bug's details), `--urgency`, `--target
  project:<id>|domain:<id>`, `--fingerprint` and `--submission-key` (generated when not given). It
  prints the `outcome` (`created`, `appended`, `occurrence` or `regression`) and the Request's page
  `url`, and `--evidence <file>...` uploads each file to the returned occurrence or entry.
- **`pidgen request list`** filters by `--state`, `--kind`, `--target`, `--source` and `--query`
  and follows every page, or reads one with `--page` and `--per-page`. **`pidgen request show`**
  prints the Request, its requester (the contact only when the server gives it) and its timeline
  with attachments.
- **Triage:** `pidgen request reply` (`--ask` to ask a question), `acknowledge`, `accept`
  (`--priority`, `--unknown`), `close` (`--reason`, with `--duplicate-of` for `duplicate` and
  `--note` for `other`, checked before sending) and `promote` (`--project`, `--workflow-type`,
  `--no-refine`) read the Request's version, send it, and print the new state.
- **Refusals:** `REQUEST_NOT_FOUND` exits 4; `REQUEST_VERSION_CONFLICT`,
  `REQUEST_TRANSITION_REFUSED`, `REQUEST_RATE_LIMITED`, `REQUEST_SOURCE_PAUSED`,
  `REQUEST_BUG_DETAILS_REQUIRED`, `REQUEST_TARGET_NEEDS_PROJECT` and `REQUEST_REPLIES_OFF` exit 5,
  whatever the HTTP status, each with its own sentence.
- **A pending fragment for Requests.** The routes are stated by the App Service and not yet
  published, so the commands are built against `contracts/pending/requests.json` (its types in
  `src/generated/requests.d.ts`, written by `npm run contract:generate`); it is deleted once the
  server publishes the routes.

### Skills: pidgen-manage-contracts, and a contract as one of three ways across projects

- **A new bundled skill, `pidgen-manage-contracts`,** teaches when an interface deserves a contract (shared
  by several pieces of work, likely to change, or worth announcing) and when to attach the spec file
  or state the interface in scope instead; finding one first with `pidgen contract list` and
  `pidgen contract show`; creating one with `pidgen contract create` from a spec file or a written
  need; revising it with `pidgen contract revise`; and linking work with
  `pidgen ticket contract implements` and `builds-against`. `pidgen skills install` installs it.
- **`pidgen-decompose-plan` and `pidgen-file-ticket` no longer say a contract cannot be created.** Work that
  spans projects carries the provider's interface one of three ways: attach the spec file to the
  consumer ticket, state the interface in its scope, or link a contract (reused, or created with
  `pidgen-manage-contracts`). A contract is never required.

### `pidgen contract create`

- **`pidgen contract create (--project <project> | --domain <domain>)`** creates a contract a
  Project or a Domain provides, with its first revision, from `-f <file>` (JSON or YAML) and flags
  that override it: `--title`, `--kind`, `--schema-format`, `--schema <file>` (a spec file's text,
  e.g. an OpenAPI document, as `native_schema`), `--markdown <file.md>`, `--owner <user id>` and
  `--existing` (`describes_existing`: the interface already exists in the provider's code). With a
  schema and no markdown it writes the document from the title and format. The body is checked
  against the agreed request before anything is sent (`INPUT_INVALID`, exit 2), and `data` is the
  created contract as `pidgen contract show` prints it.
- **A pending fragment again.** The two create routes are agreed with the App Service and not yet
  published, so the command is built against `contracts/pending/contract-create.json` (its types in
  `src/generated/contract-create.d.ts`, written by `npm run contract:generate`); it is deleted once
  the server publishes the routes.

### Domains and contracts: built against the published API

- **The four pending fragments are gone.** The server publishes the worker release, domain, Domain
  Epic and contract routes, so `contracts/openapi.json` is pulled again and
  `contracts/pending/worker-releases.json`, `domains.json`, `domain-epics.json` and
  `contracts.json` and their generated types are deleted; `npm run contract:generate` writes only
  `src/generated/api.d.ts`. Every command that used a fragment is typed from and validates against
  the published document.
- **`pidgen domain list` and `pidgen domain show` no longer fail with `UNEXPECTED_RESPONSE`.** A
  domain counts its people under `people` (`members`, `maintainers`) and its Epics under `epics`;
  `show` and every domain write answer the domain with `granted`, the people granted on it. A
  domain key the server refuses is its `DOMAIN_KEY_INVALID` (exit 2): the published request states
  the format in prose only, so the CLI no longer checks it first.
- **`pidgen contract list` and `pidgen contract show` no longer fail with `UNEXPECTED_RESPONSE`.**
  A contract's `provider` is `{project_id, kind, domain_id, key, name}` and its owner
  `owner_user_id`. A project's list is `{provides, builds_against}` (no `covered`); a domain's is
  `{own, coverage, builds_against}`. Linked work is `{work, hidden_count}`.
- **`pidgen contract revise` and `pidgen contract accept` answer the whole contract.** A revision
  requires `schema_format` and names its operations as `{name, types?}`; accept sends
  `POST /contracts/{contract_id}/revisions/{revision_number}/accept`. A revision that no longer
  waits is `CONTRACT_REVISION_NOT_WAITING` or `CONTRACT_REVISION_SUPERSEDED` (exit 5).
- **`pidgen ticket contract implements`, `builds-against` and `rm` answer the ticket's
  contracts** (`{contracts}`), each link with its `key`, `link`, `operations`, `criterion_id`,
  `linked_at` and `linked_by`.
- **`pidgen ticket create --domain` and `pidgen epic create --domain`** validate against the
  published `CreateTicketRequest`, which carries `domain_id`; `pidgen domain epics` validates
  against the published `DomainEpicBoard`.
- **The API coverage report** attributes the domain, contract, ticket contract and worker release
  routes to the commands that send them.

### Skills: `pidgen-manage-epics` and `pidgen-decompose-plan` file cross-project work under a Domain Epic

- **`pidgen-manage-epics`** files a Domain Epic: it finds the domain with `pidgen domain list`, checks the
  domain's Epics with `pidgen domain epics`, files it with
  `pidgen ticket create --kind epic --domain <domain>` (never `branch_mode` or `feature_branch`),
  and places each project's work under it by `parent_ticket_id`. It reads `PARENT_OUTSIDE_DOMAIN`
  (add the project with `pidgen domain project add`, or choose another domain),
  `DOMAIN_HAS_NO_PROJECTS`, `EPIC_FIELD_REFUSED` and the 403. Its single-project guidance is
  unchanged.
- **`pidgen-decompose-plan`**, "Work that spans Projects", files one cohort per project, each manifest's
  `epic_id` naming the same Domain Epic; finds the interface with `pidgen contract list` and
  `pidgen contract show`; and after each commit links the provider's delivery root with
  `pidgen ticket contract implements` and each consumer's root with
  `pidgen ticket contract builds-against`, naming its operations with `--operation`. Links never
  block or order work, and it reads the seven link refusals.
- **Neither skill creates or approves a contract:** when no contract fits, the work is filed and
  refinement defines the contract; linked work waits only when the Account's Contract approval
  setting asks for a person, who accepts with `pidgen contract accept`.
- **The skill lint checks it** (`tests/skills/lint.test.ts`).

### `pidgen ticket contract`: link work to a contract

- **New commands:** `pidgen ticket contract implements <ref> <contract> [--operation <op>]...` and
  `pidgen ticket contract builds-against <ref> <contract> [--operation <op>]...` link a ticket to a
  contract (`POST /api/v1/tickets/{ticket_id}/contracts`, `{contract_id, link, operations}`; no
  `--operation` sends `[]`, all of them); `data` is the link, with the criterion an implements link
  adds. `pidgen ticket contract rm <ref> <contract>` removes it
  (`DELETE /api/v1/tickets/{ticket_id}/contracts/{contract_id}`) and prints the removed link.
- **Only a delivery root implements, and a link never blocks:** it is not a dependency edge.
- **The seven link refusals** (`CONTRACT_LINK_NOT_DELIVERY_ROOT`, `CONTRACT_LINK_OUTSIDE_PROVIDER`,
  `CONTRACT_LINK_OWN_PROVIDER`, `CONTRACT_LINK_INSIDE_COHORT`, `CONTRACT_DEPRECATED`,
  `CONTRACT_RETIRED`, `CONTRACT_UNKNOWN_OPERATION`) exit 5 whatever their status.
- **The link routes join the pending fragment** `contracts/pending/contracts.json`.

### `pidgen contract`: list, show, revise and accept

- **New commands:** `pidgen contract list (--project <project> | --domain <domain>)` reads a
  project's or a domain's contracts (`GET /api/v1/projects/{project_ref}/contracts`,
  `GET /api/v1/domains/{domain_id}/contracts`); `pidgen contract show <contract>` reads one with its
  revisions, how each was accepted, and the work implementing and building against it, hidden work
  as counts (`GET /api/v1/contracts/{contract_id}`).
- **`pidgen contract revise <contract> -f <file> [--markdown <file.md>]`** sends a new revision
  (`POST /api/v1/contracts/{contract_id}/revisions`), validated before it is sent; `data` is the
  revision, with `acceptance` `automatic` or `waiting`.
- **`pidgen contract accept <contract> [--revision n]`** accepts the named revision, or the one
  waiting revision (`POST /api/v1/contracts/{contract_id}/revisions/{number}/accept`); none waiting
  exits 5 with `NO_REVISION_WAITING` and sends no accept; a 403 exits 3. There is no create
  command: contracts are defined when work is refined.
- **Built against a pending fragment**, `contracts/pending/contracts.json` (types in
  `src/generated/contracts.d.ts`).

### Domain Epics: `pidgen ticket create --domain` and `pidgen domain epics`

- **`--domain <domain>`** on `pidgen ticket create` and `pidgen epic create` files a Domain Epic:
  an Epic that holds work from several of a domain's projects, filed in the domain's home and
  owning no branch. The body is sent to `POST /api/v1/tickets` with `kind: epic` and `domain_id`
  instead of `project_id`; `--kind story` or `task`, or a file naming `project_id`, `branch_mode` or
  `feature_branch`, exits 2 with `INPUT_INVALID` and sends nothing. Without `--domain` nothing
  changes.
- **New command:** `pidgen domain epics <domain> [--state open|finished] [--page n] [--per-page n]
  [--no-subdomains]` reads a domain's Epics with their work grouped by project and the count of
  work you cannot see (`GET /api/v1/domains/{domain_id}/epics`).
- **Built against a pending fragment**, `contracts/pending/domain-epics.json` (types in
  `src/generated/domain-epics.d.ts`): the published create plus `domain_id`, and the Epics read.
- **Refusals:** `DOMAIN_HAS_NO_PROJECTS` exits 5; `DOMAIN_PROJECT_CONFLICT` and
  `EPIC_FIELD_REFUSED` exit 2; `DOMAIN_NOT_FOUND` exits 4; a 403 exits 3.

### `pidgen domain`: domains, their projects, parents, members and maintainers

- **New commands:** `pidgen domain list|show|create|edit|archive|unarchive`,
  `pidgen domain project add|rm`, `pidgen domain parent add|rm`, `pidgen domain member add|rm` and
  `pidgen domain maintainer add|rm`, calling the App Service's stated domain routes
  (`/api/v1/domains`). `maintainer rm` keeps the person as a member; `member rm` removes them.
- **Built against a pending fragment**, `contracts/pending/domains.json`, until the server
  publishes the routes: its types are generated by `npm run contract:generate` into
  `src/generated/domains.d.ts`, request bodies and every answer are validated against it, and an
  answer that does not match exits 1 with `UNEXPECTED_RESPONSE`.
- **Refusals:** `DOMAIN_CYCLE`, `DOMAIN_TOO_DEEP`, `DOMAIN_IS_ACCOUNT_ROOT`,
  `DOMAIN_COVERAGE_IN_USE` and `DOMAIN_HAS_OPEN_EPICS` exit 5 whatever their HTTP status, with the
  server's details; `DOMAIN_NOT_FOUND` and `MEMBER_NOT_FOUND` exit 4; a duplicate key (409) exits
  5; the switched-off domains feature (403) exits 3.

### The worker installs from the series the server names, verified, with `--test` for rehearsals

- **The server names a series, the index supplies the release.** `GET /api/v1/workers/releases`
  now lists one series per accepted worker protocol (`current`, `supported`), each with its
  requirement `pidgen-worker~=X.Y.0` and image tag, and no files or digests. `pidgen worker
  install`, `update`, `enroll` and `setup` take the newest release of the series from PyPI and the
  CPython 3.12 wheel for this machine (Linux x86_64 or aarch64, macOS arm64 or x86_64), verify its
  PEP 740 attestation, and run `uv tool install --python 3.12` on the verified file.
- **`--test`** on `worker install`, `worker update` and `setup` installs a release rehearsal
  (`X.Y.Z.devN`) from TestPyPI, verified against the same publisher. The install record names
  `index: testpypi`.
- **Releases are verified against Pidgen's release publisher**, an identity the CLI carries; the
  server names only the series.
- **The container form** resolves the image tag the server names to its digest with
  `docker buildx imagetools inspect`, then verifies the cosign signature over that digest before
  pulling it.
- `--version` takes a release of any series the server accepts; one of another series exits 5
  with `RELEASE_UNSUPPORTED`, and `error.details.accepted` lists the accepted series.

The first public release of `pidgen`, the command-line client for Pidgen. It supports App Service
API version 1.0 and uses the App Service's published public API document, committed as
`contracts/openapi.json`, plus the agreed pending worker-release and domain contracts.

### Commands

- **Sign in and choose an Account:** `pidgen auth login|logout|status|list|revoke` with device-code
  login or a Personal API Token, and `pidgen account list|use`. The server is `PIDGEN_API_URL`,
  else the profile's, else the hosted server, `https://api.pidgen.ai`, so `pidgen auth login` needs
  no URL on a fresh machine. A command that needs a credential and has none exits 3 with
  `AUTH_REQUIRED` before sending anything.
- **Read and file work:** `pidgen project`, `pidgen ticket list|show|create|edit|template|types`,
  owners and followers, dependencies (`pidgen ticket dep add|rm|list`) and epic placement, plus
  `pidgen epic` as aliases for epic-kind tickets with their dependency graph, `pidgen intent` for
  durable intake requests, and
  `pidgen manifest template|apply` to file a ticket with its children and edges in one previewed
  commit.
- **Plan:** `pidgen plan show|apply|promote|template`, child-plan briefs, and `pidgen plan cohorts`
  to group slices that touch the same files.
- **Act on tickets and runs:** `pidgen ticket actions` lists what a ticket, its runs and its
  dependencies allow; `pidgen ticket act` previews and executes any of them, and
  `pidgen ticket retry`, `pidgen ticket replay`, `pidgen ticket reopen`, `pidgen ticket cancel` and
  `pidgen ticket clarify` cover the common ones. `pidgen run list|show|node-output` reads runs, and
  `pidgen review list|attention` lists what needs a person.
- **Steer running agents:** `pidgen session steer` sends live or queued instructions with
  attachments and quotes, and `pidgen session instructions|edit-instruction|withdraw-instruction`
  and `pidgen ticket instructions` follow them.
- **Set up a worker:** `pidgen setup` guides a fresh machine through checks, sign-in, verified
  installation, enrollment, startup and connection verification. It resumes completed steps and
  prints the equivalent scriptable commands; without a terminal it exits 2 with
  `TERMINAL_REQUIRED`.
- **Check and install a worker:** `pidgen doctor` checks the machine and its connection;
  `pidgen worker install|verify` installs and verifies a wheel or container using signed
  provenance, against the release the server names (`GET /api/v1/workers/releases`). Enrollment
  uses the same verified install before creating an enrollment.
- **Run a worker:** `pidgen worker enroll|start|stop|status|doctor` enrolls this machine and runs
  the separately distributed `pidgen-worker`, and `pidgen worker subscriptions` shows and switches
  its provider subscriptions.
- **Update and remove a worker:** `pidgen worker update` installs a verified release and can
  restart the worker, rolling back if startup fails; `pidgen worker uninstall` removes it,
  preserving the worker home unless `--purge` is given. `pidgen worker status` reports available
  updates; nothing updates automatically.
- **Skills, feedback and the escape hatch:** `pidgen skills install|status`, `pidgen feedback`,
  and `pidgen api get|post|put|patch|delete` for any published operation, validated against the
  document.

### Conventions

- On a terminal, commands print human-readable output; otherwise, and with `--format json`, they
  print exactly one JSON envelope on standard output. Exit codes are stable, 0 to 8.
- `pidgen setup` is the only interactive command. Every other command, including
  `pidgen worker enroll`, never prompts; enrollment uses `--install` or `--no-install`.
- Anything with side effects previews first and applies only with `--apply`, the preview's
  `--digest` and explicit `--ack` codes.
- Configuration lives in `~/.config/pidgen/config.json`, environment variables are `PIDGEN_*`, and
  the CLI sends `PIDGEN-API-Version` on every request. Tokens carry the `pidgen_cli_` and
  `pidgen_pat_` prefixes the server issues; `awes_cli_` and `awes_pat_` tokens issued before still
  work.

### Skills

Ten agent skills ship in the package and call only public `pidgen` commands:
`pidgen-file-ticket`, `pidgen-decompose-plan`, `pidgen-manage-epics`, `pidgen-manage-contracts`,
`pidgen-triage-requests`, `pidgen-query-tickets`, `pidgen-retry-run`, `pidgen-replay-node`,
`pidgen-unstick-ticket` and `pidgen-setup-worker`. Their names carry the `pidgen-` prefix so they do
not collide with other skills in a shared skills directory. `pidgen-setup-worker` takes a machine
from nothing to a running, verified worker with the scriptable commands `pidgen setup` lists when
there is no terminal, then configures the worker (pool sizes, session caps per coding agent,
fallback provider logins and the primary one); for that local configuration alone it also runs the installed worker's own
`pidgen-worker capacity` and `pidgen-worker subscriptions` commands.

### Planned

- `pidgen session steer --upload` and `pidgen ticket list --epic`, which wait on the public API.
- The container runtime in `pidgen setup`; the wheel runtime is the guided path today.
- Revoking the credential on the server in `pidgen auth logout`; it forgets it locally today.
