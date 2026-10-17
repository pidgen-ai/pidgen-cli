# Pidgen CLI documentation

Use `pidgen` to connect your terminal and coding agent to Pidgen, the hosted work execution
service. File and plan work, follow runs, and operate the worker that executes work on your machine.

Install it with `npm install -g pidgen@alpha` (Node.js 22.12 or later; the CLI is in alpha). To
use the CLI without a worker, start with `pidgen auth login`, which signs in to the hosted Pidgen
server (give it a URL to use another).

Terminal stdout gets human-readable responses; nonterminal stdout gets JSON. Use `--format json`
for structured automation and `--format table` for human output. JSON envelopes and exit codes stay
stable; help/version and foreground worker output are documented exceptions in
[Output and exit codes](output-and-exit-codes.md).

## Getting started

Start with [Get started with Pidgen](getting-started.md): install the CLI, sign in, and read your
Account's projects and tickets. Then choose the next step for your workflow.

| Guide | What you will accomplish |
|---|---|
| [Get started with Pidgen](getting-started.md) | Install, sign in, find work, and create a first ticket |
| [Install agent skills](install-skills.md) | Give Claude Code, Codex, or pi the Pidgen skills and verify they are current |
| [Install and connect a worker](install-worker.md) | Prepare a machine, run guided setup, and confirm the worker is connected |
| [Troubleshooting](troubleshooting.md) | Resolve installation, sign-in, skill discovery, and worker setup problems |

You can use the CLI and skills without a local worker. To run work on this machine, follow the
worker guide and use `pidgen setup`, the CLI's one interactive command. Features that are not yet
available are marked *planned* where they would appear.

## Guides

| Guide | What it covers |
|---|---|
| [Authentication and Accounts](authentication.md) | Device-code login, Personal API Tokens, profiles, Account switching, and configuration |
| [Preview and apply](preview-and-apply.md) | Inspecting changes, applying a digest, acknowledgements, and waiting |
| [Planning work in cohorts](planning-cohorts.md) | Grouping related work so parallel pull requests do not conflict |
| [Architecture](architecture.md) | What the CLI is and is not, and how it, the agent skills and the worker connect to Pidgen |

## Reference

| Reference | What it covers |
|---|---|
| [Commands](commands.md) | The command tree, flags, input files, and public API routes |
| [Agent skills](skills.md) | The skill catalog, installation options, and status fields |
| [Workers](workers.md) | Installation, verification, enrollment, lifecycle, and status details |
| [Output and exit codes](output-and-exit-codes.md) | JSON results, terminal output, exit codes, and errors |
| [API compatibility](api-compatibility.md) | Supported versions, contract checks, and unavailable features |

To contribute to the CLI or its documentation, see [Contributing](../CONTRIBUTING.md).
