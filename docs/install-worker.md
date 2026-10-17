# Install and connect a worker

A worker runs Pidgen work on a machine you control. Install it on the machine that will execute
the work; you can use the CLI from other machines without installing a worker on each one.
The worker is the separate `pidgen-worker` program, with its own licence and credential.

## Before you start

You need:

- The [Pidgen CLI](getting-started.md#1-install-the-cli).
- Linux on x86_64 or aarch64, or macOS on Intel or Apple silicon.
- `uv` on your `PATH` for the wheel runtime. Follow the
  [uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/).
- At least one coding-agent harness required by the worker release, available on `PATH`.
  `pidgen doctor` lists the release's requirements and any missing commands.
- Permission to enroll a worker: an Account Owner or Administrator, or an eligible Personal API
  Token with `workers:enroll`.
- Network access to Pidgen and the package and verification services used to install the worker.

The wheel runtime installs the worker into its own Python 3.12 environment using `uv`. You do
not need to install `pidgen-worker` yourself first.

## 1. Run guided setup

In a terminal on the worker machine, run:

```sh
pidgen setup
```

Setup checks the machine, signs you in if needed, lets you choose an Account when you belong to
several, and asks about the runtime. It then installs and verifies the worker, enrolls the
machine, starts the worker in the background, checks its connection, and runs worker diagnostics.
Review the worker licence notice during installation; installing accepts that licence.

Guided setup currently supports the **wheel** runtime. Container installation and management
commands are available, but container enrollment through the CLI and guided container setup are
*planned*. Follow the wheel path for a complete CLI setup today.

You can answer the runtime question and name the worker in advance:

```sh
pidgen setup --runtime wheel --label development-worker
```

For another Pidgen server, add `--url https://pidgen.example.com`, replacing the placeholder with
your server address. Setup prints each command it runs. If a step fails, read `error.details.fix`,
resolve the issue, and run setup again; completed steps are detected and skipped.

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
should use the individual commands. After [authenticating](authentication.md), run these steps
in order, checking each result before proceeding:

```sh
pidgen doctor
pidgen worker install --runtime wheel
pidgen worker verify
uv tool update-shell
```

Open a new shell after updating `PATH`, and check `command -v pidgen-worker`. Alternatively, set
`PIDGEN_WORKER_BIN` to the installed executable path returned as `data.location` by the install
command. Then:

```sh
pidgen worker enroll --no-install --label development-worker
pidgen worker start --detach
pidgen worker status
pidgen worker doctor
```

Enrollment creates the worker enrollment immediately and does not start it. Background startup
checks that the process stays alive for two seconds; it does not wait for the server connection.
Check status again until the server reports it connected. See [Worker reference](workers.md)
for enrollment failures, lifecycle behavior, and automation details.

## Operate your worker

| Task | Command |
|---|---|
| Inspect status and update availability | `pidgen worker status` |
| Check the worker's own configuration | `pidgen worker doctor` |
| Stop the background worker | `pidgen worker stop` |
| Start it again | `pidgen worker start --detach` |
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
