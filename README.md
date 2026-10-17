<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="pidgen-logo.png">
    <img src="pidgen-logo.png" alt="Pidgen" height="180">
  </picture>
</p>

# Pidgen

**Say what you want built. Pidgen clarifies it, plans it, runs your coding agents on it, and hands
back verified work.**

Most tools for software teams assume a person does every step: write the issue, estimate it,
assign it, implement it, review it. [Pidgen](https://pidgen.ai) is built for teams whose coding
agents do the implementing. You describe an outcome in plain words; Pidgen asks the questions that
resolve what is unclear, turns the answer into tickets with acceptance criteria you can check,
orders them by their dependencies, and runs them with your coding agents on machines you control.
You step in where judgement is needed: approving plans, answering questions, steering or stopping
work. You don't have to groom the backlog or chase what to do next.

- **Intent in, verified work out.** Vague requests become specified, testable tickets before any
  agent starts, and work is complete only when its acceptance criteria are met.
- **Your agents, your machines.** The Pidgen worker runs on hardware you choose and uses the coding
  agents and model subscriptions you already have.
- **Oversight without busywork.** Follow every run as it happens, retry or replay a step, and see
  exactly what needs your attention.

Pidgen is a hosted service for small engineering teams. **[Request access at pidgen.ai](https://pidgen.ai).**

## This repository

The `pidgen` command-line client and the agent skills that teach your coding agent to use it.
People and their coding agents use `pidgen` to file and plan work, follow and recover runs, and
enroll the worker that executes that work on their own machine. Responses are human-readable when
standard output is a terminal and JSON when it is redirected or piped. Use `--format json` for
structured automation or `--format table` to request human output explicitly. JSON envelopes and
exit codes are preserved. Commands preview side effects before applying them; only `pidgen setup`
prompts. Help and version print text, and foreground `worker start` passes through the worker's
streams and exit status. See [Output and exit codes](docs/output-and-exit-codes.md).

## Install

```sh
npm install -g pidgen@alpha --ignore-scripts
pidgen --version
```

The CLI is in alpha: releases are published under the `alpha` tag until the first stable one.
Requires Node.js 22.12 or later. Linux and macOS are supported; Windows support is best effort,
and `pidgen worker` needs Linux or macOS.

## Get started

```sh
pidgen auth login
pidgen auth status
pidgen project list --format table
```

Approve the sign-in in your browser for the Account you want to use. Follow
[Get started with Pidgen](docs/getting-started.md) for prerequisites, finding work, and creating
your first ticket.

You can use the CLI and skills without a worker installed on this machine. To execute work here,
follow [Set up a worker](#set-up-a-worker).

## Agent skills

The CLI bundles agent skills that teach Claude Code, Codex, or pi to file, plan, follow, and
recover Pidgen work for you. Install them for your agent and check they are current:

```sh
pidgen skills install --agent claude    # or codex, pi; omit --agent for every agent found
pidgen skills status --agent claude
```

Skills install for your user by default; add `--scope project` to install them into the current
repository instead. Start a new agent session, then ask it, for example:

> Use pidgen-query-tickets to list my Pidgen projects and show any work that needs my attention.

| Skill | Use it to |
|---|---|
| `pidgen-file-ticket` | Turn a request into a ticket, answering Pidgen's clarification questions |
| `pidgen-manage-epics` | Create Epics, place tickets in them, and wire dependencies |
| `pidgen-decompose-plan` | Break related work into parent and child tickets |
| `pidgen-query-tickets` | Find and read tickets, Epics, runs, and their state |
| `pidgen-manage-contracts` | Publish or propose the interface between projects as a spec file |
| `pidgen-triage-requests` | Work the request queue: acknowledge, ask, accept, close or promote |
| `pidgen-retry-run` | Decide whether a failed or stalled run should get a fresh attempt |
| `pidgen-replay-node` | Re-run one step of a run as a new attempt |
| `pidgen-unstick-ticket` | Choose between answering a clarification, retrying, or filing new work |
| `pidgen-setup-worker` | Set up, verify, and configure a worker on this machine |

After updating the CLI, run `pidgen skills install` again to update installed copies. See
[Install agent skills](docs/install-skills.md) for a walkthrough and the
[skills reference](docs/skills.md) for every option.

## Set up a worker

Run `pidgen setup` in a terminal on the machine that will execute your work:

```sh
pidgen setup
```

You need Linux or macOS, `uv` on your `PATH`, a supported coding agent installed, and permission
to enroll workers in your Account. An Account Owner or Administrator can enroll workers; an
eligible Personal API Token with `workers:enroll` can also do so. See the
[worker installation guide](docs/install-worker.md#before-you-start) for prerequisites.

Setup checks the machine, signs you in if needed, lets you choose an Account when you belong to
several, installs and verifies the worker, enrolls it, and starts it in the background. It then
checks the server connection and runs worker diagnostics. It shows the worker licence notice
during installation; installing accepts that licence.

Guided setup currently uses the wheel runtime. To choose it and name your worker in advance:

```sh
pidgen setup --runtime wheel --label development-worker
```

Setup prints each command it runs and resumes completed steps when you run it again. If a step
fails, follow `error.details.fix`, then rerun setup. Afterward, check the worker:

```sh
pidgen worker status
pidgen worker doctor
```

The status shows whether the worker is running and whether Pidgen reports it connected; with
`--format json`, look for `data.running: true` and `data.server.worker.connected: true`.
The server view requires an Owner or Administrator's CLI credential; inspect `data.warnings`
if it is unavailable.

`pidgen setup` is the CLI's only interactive command and requires a terminal even with flags.
Coding agents and scripts should use the
[individual setup commands](docs/install-worker.md#use-separate-commands-for-automation).

## Documentation

Browse the [documentation index](docs/README.md) for getting started, guides, and reference.
Use the [command reference](docs/commands.md) to look up flags, or
[troubleshooting](docs/troubleshooting.md) if a step fails.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
