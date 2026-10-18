# Workers

For the installation walkthrough, prerequisites, and readiness checks, start with
[Install and connect a worker](install-worker.md). This reference explains lifecycle commands,
verification, enrollment, and status in detail.

Pidgen runs work on **workers** that you operate. A worker is the `pidgen-worker` program, published
on PyPI as [`pidgen-worker`](https://pypi.org/project/pidgen-worker/) separately from this CLI and
under its own licence, running on a machine you control. It connects to the
App Service with its own credential, never with your credentials.

`pidgen worker` is the front door: it installs and verifies the worker, creates the enrollment, and
hands over to `pidgen-worker`.

This page documents the CLI's side: install, enroll, start, stop, update and status. What runs on
the machine is documented by the worker itself:
[Configure the worker](https://docs.pidgen.ai/worker/configure/) (capacity and pool sizes),
[Coding agents](https://docs.pidgen.ai/worker/coding-agents/) (harnesses and subscriptions),
[Worker troubleshooting codes](https://docs.pidgen.ai/worker/troubleshooting/), and
[Run as a service](https://docs.pidgen.ai/worker/run-as-a-service/) under a service manager.

## Set up a worker

```console
$ pidgen setup [--runtime wheel] [--version <version>] [--label <label>] [--url <url>] [--agent claude|codex]… [--plan <agent>=<plan>]…
```

`pidgen setup` is the guided path from a fresh machine to a verified worker running your Account's
work, and the CLI's one interactive command. It checks the machine (`pidgen doctor`), signs you in
with a device code, lets you choose an Account when you belong to several, asks which coding
agents the worker runs (Claude Code, Codex; those on `PATH` pre-checked, or `--agent`), installs a
chosen one that is missing with npm when you say yes, signs in to each that is not signed in
(`pidgen worker login claude|codex`), asks each chosen agent's subscription plan (or `--plan`,
such as `--plan claude=max-5x`) and turns it into that agent's concurrent-session cap, asks which runtime
to install (currently `wheel`, with the licence notice), installs and verifies the worker (`pidgen
worker install`, `pidgen worker verify`), enrolls it (`pidgen worker enroll`), applies the caps
(`pidgen-worker capacity set`), starts it (`pidgen worker start --detach`), waits until the App Service reports it connected, and proves it (`pidgen
worker doctor`). Before enrolling it says whether your credential may enroll workers and, when it
may not, which roles can and how to sign in with a Personal API Token that has `workers:enroll`.

Guided container setup is *planned*. Use the wheel runtime for the complete installation,
enrollment, and startup path through this CLI.

Each step is one of the `pidgen` commands on this page, so the path can be scripted from them; setup
shows each action as one line and records the commands it runs, with their output, in its setup log
(`~/.pidgen/logs/setup-<start time>.log`; `--verbose` shows them as they run). Running it again resumes: a signed-in profile, an installed worker and an enrolled
host are skipped. Without a terminal it exits 2 with `TERMINAL_REQUIRED` and lists those commands
in `error.details.commands` ([Commands](commands.md#setup)).

## Check this machine

```console
$ pidgen doctor
```

Before installing or enrolling, `pidgen doctor` tells you everything this machine needs, without
changing anything and without a worker installed. Its `data.checks` cover the Node.js version
(`node`), the server's health and API version (`server`), your credential, its Account role and
whether it may enroll workers (`credential`), and the worker runtimes (`runtime`): `uv` for the
wheel runtime, and `docker` with `cosign` for the container runtime.

The rest come from the server's worker release list, read with no credential. The CLI carries no
harness knowledge of its own: the list names the coding-agent harnesses a worker can run and the
command each is found by.

| Check | `ok` when | Otherwise |
|---|---|---|
| `releases` | The release list was read | `fail`, naming the error and the route; `skip` when the `server` check failed |
| `harness:<kind>` | The harness's command is on `PATH` | `warn`, or `fail` when no harness the list names is on `PATH` |
| `worker` | The installed release is the server's `current` | `warn` when it is only `supported` or nothing is installed yet; `fail` when the server no longer accepts it or does not list it. The fix is `pidgen worker install` |

When the list is not read, `harness` and `worker` are `skip`. Each check is `ok`, `warn`, `fail` or
`skip` and names its `fix`, the command or address that resolves it. A failing check exits 1 with
`DOCTOR_FAILED` and the report in `error.details`; warnings exit 0 ([Commands](commands.md#doctor)).

`pidgen doctor` is not `pidgen worker doctor`: the first diagnoses this machine and its connection
to Pidgen, the second runs the installed worker's own checks.

## Install the worker

```console
$ pidgen worker install [--runtime wheel|container] [--version <version>] [--force] [--test]
```

> **Waiting on the server and the first release.** `pidgen worker install`, `pidgen worker enroll`
> with no worker installed, and `pidgen doctor` read the server's worker release list,
> `GET /api/v1/workers/releases`. A server without it answers `404`, so `worker install` and such
> an enroll exit 4 with `NOT_FOUND` and `pidgen doctor` fails its `releases` check. Until the
> worker's first release is on PyPI, installing exits 5 with `RELEASE_UNSUPPORTED`; use `--test`
> for a rehearsal from TestPyPI.

Installs the worker without enrolling it. It needs no credential and spends no enrollment, so a
machine can be prepared by someone without the role to enroll it, and a failed install costs
nothing on the server. It reads the release list from `PIDGEN_API_URL` or the profile's server,
else the hosted server, `https://api.pidgen.ai`.

1. It reads the server's worker release list with no credential and no Account. The server names
   release *series*, one per worker protocol it accepts: `current` (install this) and
   `supported` (still accepted), each with its wheel requirement, `pidgen-worker~=X.Y.0`.
2. It picks the series: the server's `current`, or the series of `--version`. A version whose
   series the server does not accept exits 5 with `RELEASE_UNSUPPORTED`;
   `error.details.accepted` lists the series it accepts.
3. It asks the package index for the series: PyPI, or TestPyPI with `--test`. It takes the newest
   release of the series (or exactly `--version`), skipping yanked files, and that release's wheel
   for this machine: the CPython 3.12 wheel for Linux x86_64 or aarch64, or macOS on Apple silicon
   or Intel. Only final releases are taken by default. A pre-release (an alpha, beta or release
   candidate: `X.Y.ZaN`, `X.Y.ZbN`, `X.Y.ZrcN`) is installed only when `--version` names it
   exactly, for example `--version 2.11.0b1`. Development builds (`X.Y.Z.devN`) are candidates
   only on TestPyPI. A series the index has no release of exits 5 with `RELEASE_UNSUPPORTED`;
   when the series has only pre-releases, `error.details.pre_release` names the newest, the one
   `--version` would install.
4. When the install record already names that version, it does nothing and exits 0 with
   `installed: false`. `--force` reinstalls it.
5. It prints the worker's licence notice to standard error, ending with the link to the licence's
   full text, `Read it: https://pidgen.ai/legal/eula`. Installing accepts the licence; there is no
   licence prompt and no flag.
6. It verifies the release's artifact ([below](#verifying-where-the-worker-came-from)) before
   anything runs. A missing or failing attestation or signature, or an artifact whose digest
   differs from the index's, exits 5 with `PROVENANCE_INVALID`, names what failed in
   `error.details.check`, and leaves nothing installed. There is no way to skip verification.
   - **Wheel:** it fetches the wheel's PEP 740 attestation from the index, downloads the wheel,
     and verifies it.
   - **Container:** it resolves the image tag the server names (`<repository>:X.Y`) to the digest
     it points at with `docker buildx imagetools inspect`, then runs `cosign verify` for
     `<repository>@<digest>`. The image is always named by that digest from then on.
7. Only then does it install the verified artifact. A failing install exits 1 with
   `INSTALL_FAILED`.
   - **Wheel:** `uv tool install --python 3.12 --python-preference only-managed <verified wheel>`,
     which gives the worker its own environment on a uv-managed Python 3.12, the interpreter the
     wheel was built for (never a system Python, which may lack CA certificates), and `uv tool dir --bin` to find the
     installed `pidgen-worker`. Both run with `UV_TOOL_DIR=$PIDGEN_HOME/worker/tools` and
     `UV_TOOL_BIN_DIR=$PIDGEN_HOME/worker/bin`, so the worker is installed in the worker home and
     never in uv's shared `pidgen-worker` tool slot (`uv tool dir`, `~/.local/bin`): it cannot
     replace a `pidgen-worker` installed some other way, or one that is running. An earlier CLI's
     install in uv's shared slot is removed once the new one is in place, unless a worker is
     running from it or the slot now holds another install's worker; either is said in one line
     and that one is left alone.
   - **Container:** `docker pull <repository>@<digest>`, then `docker volume create
     pidgen-worker-home` for the worker home. Installing runs no container.

`--test` installs a release rehearsal from TestPyPI, where `X.Y.Z.devN` builds are published before
a release. Its wheels are verified the same way, against the same publisher; nothing from TestPyPI
is accepted without that signature. The install record says `index: testpypi`, and `pidgen worker update` keeps looking
there until `--test` is dropped by a reinstall.

`--runtime` picks the form. Without it, an existing install record decides, then what the machine
has: `uv` means `wheel`, and otherwise `docker` with `cosign` means `container`. The CLI never
installs `uv`, Docker or cosign: when what the form needs is missing the command exits 2 with
`RUNTIME_UNAVAILABLE` and the install instructions in `error.details.install`.

Every command the CLI runs is composed by the CLI, printed to standard error (`$ uv tool install
…`, `$ cosign verify …`, `$ docker pull …`) before it runs, and run with an argument list, never
through a shell. Its output goes to standard error, so standard output carries only the CLI result:
human-readable output for terminal stdout, or a JSON envelope for nonterminal stdout. Use
`--format json` or `--format table` to override that selection.

`data` is the install record plus `installed`:

| Field | Meaning |
|---|---|
| `form` | `wheel` or `container` |
| `version` | The installed release |
| `index` | `testpypi` for a `--test` install; absent for PyPI |
| `artifact` | The wheel requirement, `pidgen-worker==<version>`, or the image repository without a tag |
| `digest` | `sha256:<hex>` of the verified wheel, or the verified image's manifest digest |
| `identity` | The signer (`issuer`, `subject`) the attestation or signature named, which matched an accepted publisher |
| `verified_at`, `installed_at` | When it was verified and installed |
| `location` | The installed `pidgen-worker` (`$PIDGEN_HOME/worker/bin/pidgen-worker`), or the container's name, `pidgen-worker` |
| `file` | The verified wheel, kept under `$PIDGEN_HOME/worker/` with its attestation so `worker verify` can re-check it; `null` for the container |
| `volume` | Container only: the Docker volume holding the worker home, `pidgen-worker-home` |
| `installed` | `true` when this run installed it; `false` for the no-op |

The record is written to `$PIDGEN_HOME/run/pidgen-install.json`, beside the detached worker's run
record. Later commands read it, so none of them needs `--runtime`, and every `pidgen worker`
command runs the `pidgen-worker` its `location` names.

`pidgen-worker` is not on `PATH` by name after the install: the CLI runs it by path. To run it by
name yourself, put its bin directory on `PATH` (`export PATH="$HOME/.pidgen/worker/bin:$PATH"`,
or `$PIDGEN_HOME/worker/bin`), or run `~/.pidgen/worker/bin/pidgen-worker`.

## Verify the installed worker

```console
$ pidgen worker verify
```

Re-checks the installed worker against its record: the kept wheel still has the recorded digest,
or the image `<reference>@<digest>` is still present (`docker image inspect`) (`digest`), and its
attestation, or the image's cosign signature, still verifies against an accepted publisher
identity (`provenance`). It needs no Pidgen server; for the wheel, Sigstore's trust root is
loaded, and cached under `$PIDGEN_HOME/cache/sigstore`, as for an install. `data` is `checks`, each `{id, status, summary,
fix}` as `pidgen doctor` reports them, plus the `record`; a failing check's `fix` is `pidgen worker
install --force`. A failed check exits 5 with `PROVENANCE_INVALID` and the same `checks` and
`record` in `error.details`; no install record exits 4 with `WORKER_NOT_INSTALLED`.

## Update the worker

```console
$ pidgen worker update [--version <version>] [--restart] [--test]
```

Installs `--version`, or else the newest release of the server's `current` series that is newer
than the installed one, in the recorded form with the same verification as `worker install`
(steps 1–3 and 5–7 [above](#install-the-worker); for a container, the cosign signature before
`docker pull`), and updates the install record. It looks on TestPyPI with `--test`, or when the
installed worker came from there. It needs an install record; without one it exits 4 with
`WORKER_NOT_INSTALLED`. Nothing updates on its own: the worker is only updated when you run this
command.

Without `--version`, the update follows the installed version's track and never moves backwards:

- On a final release (`2.11.0`), the candidates are the series' final releases newer than it.
  Alphas, betas and release candidates are ignored.
- On a pre-release (`2.11.1b1`, installed with `--version`), the candidates are the series' final
  releases and pre-releases newer than it, in PEP 440 order
  (`2.11.1a1` < `2.11.1b1` < `2.11.1b2` < `2.11.1rc1` < `2.11.1`); the newest wins. So a beta
  moves to the next beta, then the release candidate, then the final release. Once a final release
  is installed, later updates follow final releases only, as pip does.
- Development builds are candidates only on TestPyPI.

When no candidate is newer than the installed version it installs nothing, prints no licence
notice, and exits 0 with `updated: false` and the install record; in a terminal it says the
installed version is already the newest on its track. Only `--version` installs an older release:
it installs exactly the release it names, newer or older, pre-release or final. A series with no
release on the track at all exits 5 with `RELEASE_UNSUPPORTED`, as `worker install` does.

A worker started with `--detach`, or a running container, keeps running the old version until it
is restarted. `--restart` stops it after the install (`SIGTERM`, waiting for the global
`--timeout`) and starts it again with the same arguments (a container's are kept in its
`ai.pidgen.worker.args` label); a worker that does not stop in time exits 8 with `TIMEOUT`, the
new version installed and the old worker still running until it is restarted. If the new worker exits during the two-second startup check, the
CLI rolls back:

1. It checks that the previous version's kept wheel still has the digest it was verified with, and
   reinstalls it with `uv tool install --python 3.12 --python-preference only-managed --reinstall <kept wheel>`; for a container, it verifies the
   previous image's cosign signature again and pulls `<reference>@<digest>`.
2. It restores the previous install record (its `location` the worker home's
   `pidgen-worker`, where the previous version now is) and removes the new version's kept wheel.
3. It starts the worker again, with the same arguments, on the previous version.
4. It exits 1 with `UPDATE_ROLLED_BACK`. `error.details` has `version` (the release that did not
   start), `previous_version`, `log_tail` (the last log lines of the failed start), `record` (the
   restored install record), `running` and `worker` (the restarted worker record, or `null`).

When the previous version cannot be reinstalled — its kept wheel is missing or changed, its image
no longer verifies, or `uv` or `docker pull` fails — the command exits 1 with `ROLLBACK_FAILED`; run `pidgen worker install --version
<previous version>` to install it again.

`data` is the new install record plus `updated`, `previous_version`, `running` (whether a detached
worker or the container runs), `restarted` and, after a restart, `worker` (the worker or container
record). The superseded version's kept wheel is
removed once the update succeeds.

## Uninstall the worker

```console
$ pidgen worker uninstall [--purge]
```

Stops a detached worker or the running container (`SIGTERM`, then `SIGKILL` after the global
`--timeout`, since the worker is being removed), removes what the install put on the machine, by
the recorded form, then the install record, and exits 0:

- **Wheel:** `uv tool uninstall pidgen-worker` in the worker home's tool environment, and the
  kept wheel and attestation; a `pidgen-worker` in uv's shared tool slot is never touched. A
  record an earlier CLI made names uv's shared slot: then the shared tool is uninstalled only
  while the slot still holds the recorded version at the recorded path, and is otherwise left in
  place with a line saying so. A worker that was already removed outside the CLI is not an error. When `uv` fails while the worker is still
  installed, it exits 1 with `UNINSTALL_FAILED` and keeps the record.
- **Container:** the stopped `pidgen-worker` container (`docker rm`) and the pinned image
  (`docker image rm <reference>@<digest>`). A failing docker command exits 1 with `DOCKER_FAILED`
  and keeps the record.

The worker home (`$PIDGEN_HOME`, `~/.pidgen` by default), with the worker's credential, stays, so
installing again needs no new enrollment. `--purge` removes it too, and for a container also the
`pidgen-worker-home` Docker volume that holds the container's worker home; the CLI refuses with
`PURGE_REFUSED` (exit 5) and removes nothing when the worker home is your home directory or a
filesystem root. With no install record it exits 4 with `WORKER_NOT_INSTALLED`.

`data` is `uninstalled` (the removed install record), `stopped` (`{record, forced}` of the worker it
stopped, or `null`), `removed` (what was removed, such as `tool pidgen-worker` or
`image <reference>@<digest>`), `purged` and `worker_home`.

## Enroll a worker

```console
$ pidgen worker enroll [--label <label>] [--install | --no-install] [-- args]
```

One command takes a machine with a worker installed, or one it may install, to an enrolled worker.
The install comes first, so the enrollment is created only once a verified worker is present:

1. When `pidgen-worker` is already installed (the worker the install record names, at
   `PIDGEN_WORKER_BIN`, or with no record on `PATH`), it skips to step 3.
2. Otherwise, with `--install`, it runs the same install as `pidgen worker install`
   ([above](#install-the-worker)), with the same verification and the same commands printed to
   standard error: it reads the server's release list, picks the `current` release, shows the
   worker's licence notice, verifies the wheel against the worker's release identity, and only then
   runs `uv tool install` on the verified file and writes the install record. Installing accepts
   the licence. It never asks: `pidgen setup` is the CLI's one interactive command, and it installs
   and verifies the worker with `pidgen worker install` before enrolling. A failed or refused
   install spends no enrollment.
   - `--install` agrees in advance.
   - `--no-install` never installs. With no worker installed it exits 2 with `WORKER_NOT_FOUND`,
     makes no request, and names `pidgen worker install` in `error.details.install.command`.
   - With neither flag, on a terminal or not, it exits 2 with `INSTALL_CONFIRMATION_REQUIRED`, with
     `error.details.install`, the `release` and the `eula`, and names `pidgen setup` and `--install`.
   - The install fails as `pidgen worker install` does: without `uv` it exits 2 with
     `RUNTIME_UNAVAILABLE`; a wheel that does not verify exits 5 with `PROVENANCE_INVALID`
     and installs nothing; a failing `uv tool install` exits 1 with `INSTALL_FAILED`.
   - The installed worker is run by the path its install record names, so it need not be on
     `PATH`. An install whose worker cannot be run from there exits 2 with `WORKER_NOT_FOUND` and
     the install record in `error.details.installed`.
3. Only now it creates an enrollment in the current Account (`POST /api/v1/workers/enrollments`,
   with `--label` as its name). This needs the Account Owner or Administrator role, or a Personal
   API Token with `workers:enroll`; any other caller exits 3 with `FORBIDDEN` and no worker is
   enrolled (a worker installed in step 2 stays installed). The enrollment counts against the
   Account's worker allowance.
4. It runs `pidgen-worker enroll --token <one-time token> --server <server> --no-start` followed by
   the arguments after `--`, which win over the CLI's own. `<server>` is the server the enrollment
   was created on. The worker exchanges the one-time token there for its credential and stores it.
   The one-time token expires after 24 hours and can be used once. Enrolling does not start the
   worker: run `pidgen worker start --detach`, which records the worker so that `worker status`,
   `worker stop` and `worker update --restart` can find it (`pidgen setup` does this for you). A failing worker exits 1 with `ENROLL_FAILED` and its status
   in `error.details.exit_code`.

The enrollment response also lists install options (a container image and a Python package); the
CLI reports them in `data.install` but never runs them, and never runs any command string from a
server response. Every command the CLI runs is composed by the CLI and run with an argument list,
never through a shell. The install's and the worker's output go to standard error, so standard
output carries only the CLI result (an envelope in JSON mode). An enrollment the CLI created but could not hand to a worker is
not used and expires on its own.

`pidgen worker enroll` enrolls the `pidgen-worker` the CLI runs (see [below](#run-and-check-a-worker)). Enrolling a worker
installed in the container form through `pidgen worker enroll` is *planned*.

The one-time token goes only to `pidgen-worker`. It is never printed, never in the envelope (success
or error), and never written to the CLI's configuration. The CLI never sees or keeps the worker
credential.

## Run and check a worker

| Command | Does |
|---|---|
| `pidgen worker start [-- args]` | Runs `pidgen-worker` in the foreground with inherited standard streams and the arguments that follow `--` |
| `pidgen worker start --detach [-- args]` | Starts `pidgen-worker` in its own session and writes its output to the worker-manager log |
| `pidgen worker stop [--force]` | Stops the worker started with `--detach`; `--force` kills it if it does not stop before the global `--timeout` |
| `pidgen worker status [--host <host_id>]` | Shows the detached worker record, whether that process is still the recorded `pidgen-worker`, and the App Service's record of this worker ([below](#the-app-services-view)) |
| `pidgen worker doctor [-- args]` | Runs `pidgen-worker doctor --json` and returns the report using the selected output format (an envelope in JSON mode); for this machine before a worker is installed, use [`pidgen doctor`](#check-this-machine) |

The CLI runs the `pidgen-worker` at `PIDGEN_WORKER_BIN` when it is set; otherwise the one the
install record names (`$PIDGEN_HOME/worker/bin/pidgen-worker` for an install by this CLI); and
only when there is no install record, the first `pidgen-worker` on `PATH`. A recorded worker that is
missing exits 2 with `WORKER_NOT_FOUND` and its path in `error.details.location`; the CLI does not
fall back to another one on `PATH`. It sets `PIDGEN_HOME` for the worker,
using `~/.pidgen` when the variable is unset, and removes `PIDGEN_TOKEN` from the worker's environment:
the worker never receives a person's credential. Worker commands are supported on Linux and macOS. A
missing worker or unsupported platform is a usage error.

Foreground `worker start` forwards `SIGINT` and `SIGTERM` and exits with the worker's status (or 128
plus the signal number). Because it is a foreground handoff, its standard streams belong to the
worker and the CLI does not print an output envelope.

With `--detach`, the CLI starts the worker in a new session with no terminal. Standard output and
standard error are appended to `worker-manager.log` under `PIDGEN_WORKER_LOG_DIR`, or under
`$PIDGEN_HOME/logs` when that variable is unset. The CLI records the process id, start time, log path,
and command in `$PIDGEN_HOME/run/pidgen-worker.json`. It waits two seconds before reporting success.
If the worker exits during that check, the command exits 1 with `WORKER_EXITED` and includes the
last 20 log lines in `error.details.log_tail`.

Only one recorded worker may run at a time. Another detached start exits 5 with
`WORKER_ALREADY_RUNNING`. A record is stale when its process is gone or its process is not the
recorded `pidgen-worker`; a detached start replaces such a record. `worker status` retains and reports a
stale record with `running: false`. `worker stop` sends `SIGTERM` and waits for the global `--timeout`
(120 seconds by default). It exits 8 with `TIMEOUT` if the process remains, or sends `SIGKILL` when
`--force` is present. With no running record, it exits 4 with `WORKER_NOT_RUNNING`.

A failed doctor exits 1 with `DOCTOR_FAILED` and includes the diagnostic report in `error.details`.
The worker documents its diagnostic codes in
[Worker troubleshooting codes](https://docs.pidgen.ai/worker/troubleshooting/).

A detached worker is not restarted after a reboot. To keep it running across reboots, run
`pidgen-worker` under a service manager as described in
[Run as a service](https://docs.pidgen.ai/worker/run-as-a-service/).

### In a container

When the install record's form is `container`, the same commands act on one named container,
`pidgen-worker`, running the verified image by its digest, with the worker home in the Docker
volume `pidgen-worker-home` mounted at `/pidgen` (`PIDGEN_HOME=/pidgen` in the container). The
record decides; none of the commands takes `--runtime`.

| Command | Runs |
|---|---|
| `worker start [-- args]` | `docker run --rm --interactive --name pidgen-worker --volume pidgen-worker-home:/pidgen --env PIDGEN_HOME=/pidgen <reference>@<digest> [args]` in the foreground, forwarding `SIGINT` and `SIGTERM`, and exits with its status |
| `worker start --detach [-- args]` | The same with `--detach` instead of `--rm --interactive`; both label the container with its arguments (`--label ai.pidgen.worker.args=<JSON>`). It waits two seconds and reads the container's state; a container that has already stopped exits 1 with `WORKER_EXITED` and the last 20 lines of `docker logs` in `error.details.log_tail` |
| `worker stop [--force]` | `docker kill --signal SIGTERM pidgen-worker`, waits for the global `--timeout`, then `docker rm pidgen-worker`. A container still running exits 8 with `TIMEOUT`, or with `--force` is killed (`docker kill`) and removed |
| `worker status` | `docker inspect --type container pidgen-worker`: `record` is `{container, id, image, volume, status, started_at, args}` (or `null` when there is no container) and `running` |
| `worker doctor [-- args]` | `docker exec pidgen-worker pidgen-worker doctor --json [args]` in the running container |

A running container makes another `start` exit 5 with `WORKER_ALREADY_RUNNING`; a stopped one is
removed and replaced. `stop` and `doctor` exit 4 with `WORKER_NOT_RUNNING` when the container is
not running. A Docker daemon that cannot be reached exits 2 with `RUNTIME_UNAVAILABLE`; any other
failing docker command exits 1 with `DOCKER_FAILED`, its status and its error output in
`error.details`. Commands that change something are printed to standard error before they run.

## The App Service's view

When a credential is configured, `pidgen worker status` also reads the Account's workers
(`GET /api/v1/workers`) and reports the one whose host id is this machine's host name, or the host
id given with `--host`. That route needs the Account Owner or Administrator role; no Personal API
Token scope reaches it.

`data` then has `record`, `running` and `update` as before, plus:

- `server`: `host_id` (the host id looked for), `enrolled`, `worker`, and the service's
  `service_protocol` and `accepted_protocols`. `worker` is the server's record of this worker —
  `last_seen_at`, `connected`, `protocol` and `protocol_state` (`current`, `outdated`,
  `unsupported` or `unknown`), `build_version`, `revoked_at`, and `git_credentials`: per Project
  remote it serves, whether its last report found a local git credential (`covered`, `missing` or
  `stale`). It never includes the worker's credential.
- `warnings`: what could not be shown, each with a `code`, `message` and `details`.

| Situation | Result |
|---|---|
| No server or no credential configured | Local only: `data` is `{record, running, update}` and no request is made |
| The server lists a worker with this host id | `server.enrolled: true`, `server.worker` is its record; an unrevoked record is preferred over a revoked one |
| No worker with this host id, or only a revoked one | `server.enrolled: false`, `server.worker` is `null` (or the revoked record); exit 0, not an error |
| The server cannot be reached, times out, or refuses | `server: null` and a warning carrying the error's code (`NETWORK`, `TIMEOUT`, `FORBIDDEN`, …); exit 0 |
| The configuration cannot be read | `server: null` and a warning with its code (`CONFIG_INVALID`, `CONFIG_PERMISSIONS`); exit 0 |

`worker status` always exits 0 once it has read the local record; only a usage error (an empty
`--host`) or an unsupported platform fails it. An install record that cannot be read is a
warning (`INSTALL_RECORD_INVALID`) with `update.installed: null`.

### Is an update needed

`update` says whether the worker should be updated, and why:

| Field | Meaning |
|---|---|
| `installed` | The version the install record names, or `null` with no record |
| `current` | The server's `current` release, or `null` when the release list was not read |
| `needed` | `true` when `reason` is not `null` |
| `reason` | `protocol_unsupported`, `protocol_outdated`, `newer_available`, or `null` |

`protocol_unsupported` (the server will not give this worker work) and `protocol_outdated` (it
still will, for now) come from the server's record of the worker, its `protocol_state`.
`newer_available` comes from the release list: its `current` is newer than `installed`. The
protocol reasons win over `newer_available`. With a credential, after `GET /workers`, the CLI reads
the release list with no credential (`GET /api/v1/workers/releases`); a list that cannot be read
leaves `current: null` and adds a warning, and an unreachable server is not asked for it. Without a
credential nothing is requested, so `current` is `null`. Run `pidgen worker update` to update.

Human worker results name the operation and retain the install/run records, protocol and update
state, verification checks and fixes, and any warnings in labeled sections. A successful local
status read still exits 0 when the service is unreachable; the output explains that limitation
and retains the warning. Diagnostic failures show their code, message, failed checks and fixes.
Startup and update failures also retain supplied log tails and rollback/restart information.

```console
$ pidgen worker status --format table
$ pidgen worker verify --format table
$ pidgen worker status --format json
```

Installation commands, verification progress and enrollment output keep their established stderr
streams. Foreground `worker start` inherits the worker's streams and status in every output format.

## Provider subscriptions

A worker may hold several subscriptions per harness, in fallback order, and names its primary in
its `node.yaml`. `pidgen worker subscriptions <worker>` shows them as the worker last advertised them,
with each one's login, entitlement, quota and pause, and `pidgen worker subscriptions use <worker>
<harness> <label>` asks the worker, through the App Service, to make one primary
([Commands](commands.md#worker-subscriptions)). Switching from the App Service needs the Account's
`multiple_subscriptions` entitlement; `pidgen-worker subscriptions use` on the worker itself is
always allowed. Signing in to a harness and ordering subscriptions in `node.yaml` happen on the
worker: see [Coding agents](https://docs.pidgen.ai/worker/coding-agents/).

Human subscription results keep connection and advertisement state, primary and active labels,
login errors, entitlement, quota observations and pause windows. Quota summaries retain observation
ages alongside the complete timestamps and reset information. A change with `outcome: unknown`
keeps its detail and asks you to check subscriptions before retrying; the command's original exit
status is preserved.

## Verifying where the worker came from

`pidgen worker install`, `pidgen worker update` and `pidgen worker verify` verify the wheel and the
container image as described here. Every worker wheel is uploaded with its PEP 740 attestation by
the release workflow; a wheel without one is refused with `PROVENANCE_INVALID`.

The CLI trusts a publisher identity it carries, not the server. Every worker release is signed
through Sigstore by Pidgen's release process, and the CLI accepts a wheel or image only when that
signature verifies against the identity it carries and covers exactly the artifact it downloaded.
The server names only the series to install; the file and its digest come from the package index,
and neither is trusted until the attestation verifies.

- **The Python package.** The CLI computes the sha256 of the exact wheel it downloaded, fetches
  that file's PEP 740 attestation from PyPI, verifies the attestation's Sigstore bundle, checks it
  was signed by the release identity, and checks that it attests this file's name and sha256.
- **The container image.** The CLI runs `cosign verify --certificate-oidc-issuer <issuer>
  --certificate-identity-regexp <subject> <image>@<digest>` and accepts only a passing result for
  that digest; the image is then pulled by the digest, and only that digest is ever run. `cosign`
  must be installed for the container runtime; without it the CLI exits 2 with
  `RUNTIME_UNAVAILABLE` (or `COSIGN_NOT_FOUND` when it disappears mid-command). Verifying the
  registry's signatures without `cosign` is *planned*.

Anything else is refused with exit 5 and `PROVENANCE_INVALID`. `error.details.check` names what
failed:

| `check` | Meaning |
|---|---|
| `attestation` | The artifact has no attestation or signature, or it is not a PyPI publish attestation |
| `signature` | The Sigstore bundle or cosign signature does not verify |
| `identity` | It was signed by an identity other than the worker's release workflow; `details.accepted` lists the accepted ones |
| `digest` | The signature covers a different file or digest than the one downloaded, or than the release names |
| `reference` | The image reference is not a plain repository reference |

There is no flag or setting that turns verification off.

## Why the CLI does not bundle the worker

The worker is closed source and released on its own schedule, and the App Service decides which
worker versions it accepts. The server's release list names the releases it accepts, and the
CLI installs one only after verifying that the worker's release workflow signed it.
