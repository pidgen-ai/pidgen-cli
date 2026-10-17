# Troubleshooting

When a command fails, it names an error code, a message, and the details: `error.code`,
`error.message`, and `error.details` with `--format json`. For guided setup, the details' `step`,
`command`, and `fix` identify the failed step and how to resume. [Output and exit codes](output-and-exit-codes.md) is the full error reference.

## Installation

| Problem | What to do |
|---|---|
| Node.js is too old | Check `node --version`. Install Node.js 22.12 or later, then reopen your terminal and reinstall the CLI. |
| `pidgen: command not found` after installation | Check `npm prefix -g`. Ensure your npm global executable directory is on `PATH` (`<prefix>/bin` on Linux and macOS, the prefix itself on Windows), then reopen your terminal and run `pidgen --version`. |
| npm reports a permissions error | Use a Node.js installation with a user-writable npm global directory, or configure npm's global prefix for your user, then reinstall. |

## Sign-in and Accounts

| Problem | What to do |
|---|---|
| `AUTH_REQUIRED`, `TOKEN_INVALID`, or `TOKEN_EXPIRED` | Run `pidgen auth login` and approve access for the intended Account. For automation, check or replace its Personal API Token. |
| Login code expires or approval is denied | Run `pidgen auth login` again and approve the new code before it expires. |
| You see the wrong Account's work | Run `pidgen auth status` and `pidgen account list`. Switch with `pidgen account use ACC-EXAMPLE`, replacing the placeholder. Sign in for that Account first if it has no stored credential. |
| Projects or tickets are missing | Confirm the Account, then ask its administrator about project access. Empty lists are successful results. |
| `API_VERSION_UNSUPPORTED` | Update the CLI with `npm install -g pidgen@alpha --ignore-scripts`, then run `pidgen auth status --check`. Refresh your installed skills too. |
| `NETWORK` or `TIMEOUT` | Check the server address, network connectivity, and proxy settings. Use `--timeout <seconds>` if a request or connection needs longer. |

For profiles, environment overrides, and headless login, see [Authentication](authentication.md).

## Agent skills

| Problem | What to do |
|---|---|
| “No supported agent found” | Specify `--agent claude`, `--agent codex`, or `--agent pi`. Automatic detection checks marker directories in your home directory. |
| The agent cannot see the skills | Check the install result's `dir`, the selected agent and scope, and the agent's skill list. For project scope, install from the repository root. Start a new agent session. |
| `missing` or `stale` skills | Run `pidgen skills install` with the same `--agent` and `--scope` as the status command. |
| `edited` or `skipped_edited` skills | Review and back up your edits. Use `--force` only when you want the bundled version to replace them. |
| `data.contract.state` is `different` or `unchecked` | Inspect the contract comparison or its `reason`. Check for a CLI update or restore server connectivity. These states do not fail the status command. |
| The agent cannot run `pidgen` or sign in | Check `pidgen --version` and `pidgen auth status` in the agent's execution environment. It needs the CLI on `PATH` and access to the intended profile. |

See [Install agent skills](install-skills.md) for the complete path.

## Workers

| Problem | What to do |
|---|---|
| `TERMINAL_REQUIRED` | Run `pidgen setup` in a terminal, or use the [individual commands](install-worker.md#use-separate-commands-for-automation). Flags do not make setup headless. |
| `RUNTIME_UNAVAILABLE` | Install the runtime named in `error.details.install`. Guided setup requires `uv` on `PATH`. |
| `pidgen doctor` fails | Inspect `error.details.checks` and each check's `fix`. Before sign-in, the credential check can fail; before installation, the worker check may warn. Resolve the runtime, release, and harness requirements before installing. |
| `RELEASE_UNSUPPORTED` | Inspect the accepted series in `error.details`. The server needs a supported, published release; selecting another version must stay within those series. |
| `PROVENANCE_INVALID` | Installation or verification did not pass. Inspect `error.details.check` and report the failure; the CLI has no verification bypass. |
| `WORKER_NOT_FOUND` after installation | Run `uv tool update-shell` and open a new shell, or set `PIDGEN_WORKER_BIN` to the executable path in the install result's `data.location`. |
| `ENROLL_NOT_PERMITTED` or `FORBIDDEN` during enrollment | Ask an Account Owner or Administrator to enroll the machine, or use an eligible Personal API Token with `workers:enroll`. |
| `ENTITLEMENT_LIMIT_REACHED` | The Account has used its worker allowance. Ask an administrator to review existing enrollments in the web app. |
| `WORKER_EXITED` or `WORKER_NOT_CONNECTED` | Inspect `error.details.log_tail` or the reported log path. Run `pidgen worker doctor`, fix the reported issue, and rerun setup. |
| Status is successful but the worker is unavailable | Check `data.running`, `data.server`, and `data.warnings`. A successful status command does not guarantee a running or connected worker. |

`pidgen doctor` checks the machine before installation. `pidgen worker doctor` checks the installed
worker. See [Install and connect a worker](install-worker.md) and the [Worker reference](workers.md).

## Get help

Use `pidgen <noun> <verb> --help` for a command's flags, or browse the
[command reference](commands.md). To report a problem from the CLI:

```sh
pidgen feedback --kind not-working "Describe the command, error code, and what you expected."
```

This sends your message to Pidgen immediately. Include the CLI version and relevant error code.
Do not include tokens, credentials, or sensitive log content.
