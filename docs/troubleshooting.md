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
| Setup failed and the screen shows too little | The failed task's last ten lines are on screen; everything setup ran, with its full output and the error in full, is in the setup log it names, `~/.pidgen/logs/setup-<start time>.log`. Run `pidgen setup --verbose` to watch the commands as they run. |
| `TERMINAL_REQUIRED` | Run `pidgen setup` in a terminal, or use the [individual commands](install-worker.md#use-separate-commands-for-automation). Flags do not make setup headless. |
| `SETUP_CANCELLED` | Ctrl-C at one of setup's questions stopped it, or you answered no to the install question (the worker wasn't installed) or to enrolling a removed worker again. Everything it finished is kept: run `pidgen setup` again to continue, and accept the licence (or give `--accept-licence`) to install the worker. |
| `RUNTIME_UNAVAILABLE` | Install the runtime named in `error.details.install`. Guided setup requires `uv` on `PATH`. |
| `pidgen doctor` fails | Inspect `error.details.checks` and each check's `fix`. Before sign-in, the credential check can fail; before installation, the worker check may warn. Resolve the runtime, release, and harness requirements before installing. |
| `RELEASE_UNSUPPORTED` | Inspect the accepted series in `error.details`. The server needs a supported, published release; selecting another version must stay within those series. When `error.details.pre_release` names a version, the series has only pre-releases: install it explicitly with `--version <pre_release>`. |
| `PROVENANCE_INVALID` | Installation or verification did not pass. Inspect `error.details.check` and report the failure; the CLI has no verification bypass. |
| `WORKER_NOT_FOUND` after installation | The worker the install record names (`error.details.location`, normally `~/.pidgen/worker/bin/pidgen-worker`) is missing: run `pidgen worker install --force`. The CLI runs the recorded worker by path, so it need not be on `PATH`; `PIDGEN_WORKER_BIN` overrides it. |
| `pidgen-worker: command not found` | The CLI installs the worker in `~/.pidgen/worker/bin`, not on `PATH`. Run it by path, or `export PATH="$HOME/.pidgen/worker/bin:$PATH"`. |
| `ENROLL_NOT_PERMITTED` or `FORBIDDEN` during enrollment | Ask an Account Owner or Administrator to enroll the machine, or use an eligible Personal API Token with `workers:enroll`. |
| `ENTITLEMENT_LIMIT_REACHED` | The Account has used its worker allowance. Ask an administrator to review existing enrollments in the web app. |
| `CLI_USAGE` at `enroll` | The Account already lists a worker under the name `--label` gave, and it is not this install's. Run setup with another `--label`, such as the one in the fix, or without `--label` to be offered a free name. |
| `ENROLL_FAILED` naming `pidgen feedback` | The worker's home holds no credential after enrolling (`worker.env` has no `PIDGEN_NODE_TOKEN`), so setup did not start it. That is a setup bug: report it with `pidgen feedback --kind not-working`. |
| Setup offers a name such as `my-host-2` | The Account already lists a connected or enrolled worker under this machine's host name that is not this install's (for example one that keeps its settings in another folder). Setup never adopts it: accept the free name, type another, or pass `--label`. |
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
