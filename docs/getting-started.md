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
| Execute Pidgen work on this machine | [Install and connect a worker](install-worker.md) |
| File a ticket directly from your terminal | [Create your first ticket](#create-your-first-ticket) |
| Look up a command or flag | [Command reference](commands.md) or `pidgen --help` |

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
