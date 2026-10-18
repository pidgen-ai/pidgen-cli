# Get started with Pidgen

Use the Pidgen CLI to connect your terminal and coding agent to Pidgen, find your projects,
and file and follow work. This guide takes you from installing the CLI to reading your Account's
work. You can then install agent skills or set up a worker on a machine you control.

The **CLI** is the `pidgen` command. **Skills** teach your coding agent how to use that command.
A **worker** is the separate program that executes Pidgen work. You can use the CLI and skills
without installing a worker on this machine.

## Before you start

You need:

- Node.js **22.12 or later**, with npm. Check with `node --version` and `npm --version`.
- A Pidgen sign-in and membership in an **Account**, the workspace that owns your projects and work.
- A browser to approve your CLI sign-in.

Linux and macOS are supported. The CLI's Windows support is best effort; workers require Linux
or macOS. To file work, you also need a project in your Account. If you do not have an Account
or project yet, arrange access in the Pidgen web app or with your Account administrator.

## 1. Install the CLI

Run these commands in your terminal:

```sh
npm install -g pidgen@alpha --ignore-scripts
pidgen --version
```

The CLI is in alpha, so releases are published under the `alpha` tag. The version command prints
the CLI version and the API version it uses. If your shell cannot
find `pidgen`, see [Installation troubleshooting](troubleshooting.md#installation).

## 2. Sign in

```sh
pidgen auth login
```

Open the verification address printed in your terminal, sign in in your browser, enter the
displayed code, and approve access for the Account you want to use. Leave the terminal command
running until it completes. The CLI stores the verified credential locally and never prints it.

With no configuration, login uses the hosted Pidgen service. If your organization gave you a
different Pidgen server address, pass that address to `pidgen auth login` instead. For example:

```sh
pidgen auth login https://pidgen.example.com
```

`pidgen.example.com` is a placeholder; replace it with the address you were given.

Check your sign-in:

```sh
pidgen auth status
```

It shows the Account you are signed in to, your role in it, and the server. A login is for one
Account. If you
belong to several, see [Switch Accounts](authentication.md#switch-accounts).

## 3. Find your project and work

```sh
pidgen project list
pidgen ticket list
```

The first command shows the projects you can access; the second shows your Account's tickets.
An empty list is a successful result: there may be no projects or tickets yet, or you may need
access from your Account administrator.

To read one project or ticket, use a project ID or ticket-key prefix from the project list, or
a ticket key from the ticket list:

```sh
pidgen project show EXAMPLE
pidgen ticket show EXAMPLE-12
```

Replace `EXAMPLE` and `EXAMPLE-12` with your own values. These commands only read work.

In a terminal, commands print human-readable results. When their output is piped or redirected,
or with `--format json`, they print one JSON document instead: `ok: true` means the command
succeeded, `data` holds its result, and `error` is `null`. Coding agents and scripts should pass
`--format json` and read that. See [Output and exit codes](output-and-exit-codes.md) for the full
contract and its exceptions.

## 4. Choose your next step

| You want to… | Continue with |
|---|---|
| Ask a coding agent to file, plan, or follow work | [Install agent skills](install-skills.md) |
| Execute Pidgen work on this machine | [Set up a worker](#set-up-a-worker), then [Install and connect a worker](install-worker.md) for the details |
| File a ticket directly from your terminal | [Create your first ticket](#create-your-first-ticket) |
| Look up a command or flag | [Command reference](commands.md) or `pidgen --help` |

## Set up a worker

A worker runs Pidgen work on a machine you control, using the coding agents installed there. On a
Linux or macOS machine with the CLI installed, run:

```sh
pidgen setup
```

`pidgen setup` is the CLI's one interactive command. It walks through eight steps, showing one
question or task at a time: you answer with the arrow keys, space and Enter, and each answer
collapses to one line, such as `◇  Coding agents · Claude Code, Codex`. Ctrl-C at a question stops
setup and keeps everything it finished; run it again to continue.

1. **Check this machine.** Runs `pidgen doctor`, and offers to install `uv` when it is missing.
   `git` 2.25 or later is required.
2. **Sign in to Pidgen.** Signs you in with a device code, if you are not signed in already.
3. **Choose coding agents.** Tick Claude Code, Codex, or both; the ones on this machine start
   ticked. Ticking one that is missing installs it with npm, with no further question.
   `--agent claude` or `--agent codex` (repeatable) answers in advance.
4. **Sign in to coding agents.** Runs `pidgen worker login <agent>` for each chosen agent that is
   not signed in; the agent's own login runs in your terminal.
5. **Size coding agent sessions.** Asks how many of each agent's sessions run at once: a choice of
   numbers, each with the plans it suits, or *Custom…* for any whole number from 1.
   `--sessions claude=4` (repeatable) answers in advance, and so does `--plan claude=max-5x`.
6. **Install the worker.** Asks once, `Install pidgen-worker <version> and accept its licence?`,
   naming the licence and linking its full text (`Read it: https://pidgen.ai/legal/eula`), then
   installs and verifies the worker. `--accept-licence` answers yes in advance.
7. **Enroll and start the worker.** Enrolls this machine, applies the session caps, starts the
   worker and waits until Pidgen reports it connected.
8. **Prove the worker works.** Runs the worker's own checks, then ends with the time setup took
   and a summary card: what was set up, how to manage it, and the next thing to do.

Run it again on a finished machine and it asks what to do: check everything and stop, change the
coding agents or sessions, or update the worker when a newer release is out.

To answer every question in advance:

```sh
pidgen setup --agent claude --sessions claude=2 --accept-licence
```

The hints start from each agent's plan; `--plan` takes the plan instead of a number:

| Coding agent | Plan | Sessions at a time |
|---|---|---|
| Claude Code | Pro | 1 |
| Claude Code | Max 5x | 2 |
| Claude Code | Max 20x | 4 |
| Claude Code | API key, Team or Enterprise | 2 |
| Claude Code | Not sure | 1 |
| Codex | Plus | 1 |
| Codex | Pro | 3 |
| Codex | Business or Enterprise | 2 |
| Codex | API key | 2 |
| Codex | Not sure | 1 |

To change a cap later, run the worker's own command, such as
`pidgen-worker capacity set claude --max 4` (`--max 0` switches an agent off), or run
`pidgen setup --sessions claude=4` (or `pidgen setup --plan claude=max-20x`) again. If a step
fails, setup shows one block: what failed and why, the fix, the setup log, and
`Run pidgen setup again to continue from here.`
[Install and connect a worker](install-worker.md) covers each step, the `--sessions` and `--plan` values, and the
commands to use without a terminal.

## Create your first ticket

If you prefer working through your coding agent, install the [agent skills](install-skills.md)
first. For a ticket you write yourself, generate an annotated YAML file:

```sh
pidgen ticket template --output first-ticket.yaml
```

Open `first-ticket.yaml` in your editor. Replace the title and objective, set `project_id` to
your project's ID or ticket-key prefix, and write observable acceptance criteria. Remove or
fill in the remaining placeholders. Keep `start_refinement: false` to create a Backlog ticket
without immediately starting refinement.

Review the file before running:

```sh
pidgen ticket create -f first-ticket.yaml
```

**This command creates the ticket immediately.** It does not have a preview or need `--apply`.
It validates the file before sending it. An invalid file produces `INPUT_INVALID` and creates
nothing; the error lists the fields to fix (`error.details.issues` with `--format json`).

Read the ticket using the key returned in the result:

```sh
pidgen ticket show EXAMPLE-12
```

Creating a ticket does not prove it has started running. Use `ticket show` to follow its stage
and `pidgen ticket actions EXAMPLE-12` to see what you can do next. When a command supports a
preview, inspect that preview before applying it with its digest and any acknowledgements you
explicitly accept. [Preview and apply](preview-and-apply.md) explains that flow and the commands
that act directly.

If a step fails, start with [Troubleshooting](troubleshooting.md).
