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
| Login code expires or approval is denied | Run `pidgen auth login` again and approve the new code before it expires. In `pidgen setup`, choose *Wait again with a new code*. |
| Setup seems stuck waiting for approval (`pidgen setup`) | Setup checks for your approval at the server's interval and shows `checked <n>s ago` on its live line; once you approve, it signs in within one interval. Press Enter to open the link in your browser (or to check at once), n for a new code, or Esc for other options, such as signing in with a token instead. If the live line says `Can't reach <server>; still trying`, check your network. The setup log (`~/.pidgen/logs/setup-<time>.log`) records each check with its time and outcome, and `poll delayed <n>s` if a check was held up. |
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
| `SETUP_CANCELLED` | Ctrl-C at one of setup's questions, during a task or while it waited for you to sign in (or SIGTERM) stopped it, you chose *Quit setup*, or you answered no to the install question (the worker wasn't installed) or to enrolling a removed worker again. Everything it finished is kept: run `pidgen setup` again to continue, and accept the licence (or give `--accept-licence`) to install the worker. |
| `RUNTIME_UNAVAILABLE` | Install the runtime named in `error.details.install`. Guided setup requires `uv` on `PATH`. |
| `pidgen doctor` fails | Inspect `error.details.checks` and each check's `fix`. Before sign-in, the credential check can fail; before installation, the worker check may warn. Resolve the runtime, release, and harness requirements before installing. |
| `RELEASE_UNSUPPORTED` | Inspect the accepted series in `error.details`. The server needs a supported, published release; selecting another version must stay within those series. When `error.details.pre_release` names a version, the series has only pre-releases: install it explicitly with `--version <pre_release>`. |
| `PROVENANCE_INVALID` | Installation or verification did not pass. Inspect `error.details.check` and report the failure; the CLI has no verification bypass. |
| `WORKER_NOT_FOUND` after installation | The worker the install record names (`error.details.location`, normally `~/.pidgen/worker/bin/pidgen-worker`) is missing: run `pidgen worker install --force`. The CLI runs the recorded worker by path, so it need not be on `PATH`; `PIDGEN_WORKER_BIN` overrides it. |
| `pidgen-worker: command not found` | The CLI installs the worker in `~/.pidgen/worker/bin`, not on `PATH`. Run it by path, or `export PATH="$HOME/.pidgen/worker/bin:$PATH"`. After `pidgen worker update` moved an earlier CLI's install out of `~/.local/bin`, also point any service or script that names `~/.local/bin/pidgen-worker` at the new path. |
| `pidgen-worker --version` differs from `pidgen worker status` | Another `pidgen-worker` is first on `PATH`; the CLI runs the one its install record names and never updates the other. `pidgen doctor`'s `worker` check names both. Put the CLI's first on `PATH` with `export PATH="$HOME/.pidgen/worker/bin:$PATH"`, or remove the other copy. |
| `ENROLL_NOT_PERMITTED` or `FORBIDDEN` during enrollment | Ask an Account Owner or Administrator to enroll the machine, or use an eligible Personal API Token with `workers:enroll`. |
| `ENTITLEMENT_LIMIT_REACHED` | The Account has used its worker allowance. Ask an administrator to review existing enrollments in the web app. |
| `WORKER_NAME_TAKEN` from `pidgen worker enroll` (exit 5) | The App Service refused the enrollment's name (`error.details.display_name`) because the Account already holds it, by a live worker or a pending enrollment; another person's pending enrollments are not visible to the CLI. No enrollment was created. Enroll under the name it suggests, `error.details.suggested_name`: `pidgen worker enroll --label <suggested_name> -- --host-id <suggested_name>`, or run `pidgen setup`, which asks for a name. |
| `WORKER_NAME_TAKEN` at setup's `enroll` step (exit 5) | You gave `--label`, and the Account already lists a live worker by that name, or the App Service refused it as taken. Setup created and started nothing. Run it again with the name its fix offers, `pidgen setup --label <suggested name>`, or without `--label` to be asked for one. |
| `WORKER_CREDENTIAL_PRESENT` from `pidgen worker enroll` | The worker home's `worker.env` (`error.details.path`) already holds a credential, and `pidgen-worker` would keep it and never redeem a new enrollment, so none was created. Run `pidgen worker start --detach` to use the saved credential, or `pidgen worker enroll --replace-credential` to move it aside and enroll anew. |
| `WORKER_CREDENTIAL_PRESENT` at setup's `enroll` step | `worker.env` holds a credential for another Pidgen server (`error.details.server`), or one naming no server. Setup enrolled nothing. To enroll this machine with this server, move the file aside (`mv ~/.pidgen/worker.env ~/.pidgen/worker.env.old`) and run `pidgen setup` again; to keep it, run setup with another `PIDGEN_HOME`. |
| `WORKER_HOST_TAKEN` from `pidgen worker enroll` (exit 5) | Pidgen refused the worker's host id (`error.details.host_id`) because another worker holds it (`pidgen-worker enroll` reported `HTTP 409 WORKER_HOST_TAKEN`). Host ids are unique across Accounts, so the holder can be a worker of another Account, which you cannot see, or this Account's removed worker on a server that does not yet let an Account reclaim a removed worker's name. Removing a worker on the Workers page does not free its name there. Enroll under another name, `pidgen worker enroll --label <name> -- --host-id <name>`, or run `pidgen setup`, which picks a free one. The refused enrollment was withdrawn (`error.details.withdrawn` is `true`), so nothing is left waiting. |
| `▲  <name> is taken in Pidgen, so this worker needs another name.` during setup | Pidgen refused the name at setup's enroll step: `WORKER_NAME_TAKEN` from the App Service (nothing was created), or `WORKER_HOST_TAKEN` from `pidgen-worker enroll`. Setup asks `Worker name` again, defaulting to the name the server suggests for `WORKER_NAME_TAKEN`, or the next free name (`<name>-2`, then `-3`) for `WORKER_HOST_TAKEN`, enrolls under your answer, then starts the worker as usual; the setup log records the refusal. No action is needed beyond answering. |
| `WORKER_HOST_TAKEN` at setup's `enroll` step (exit 5) | You gave `--label`, and Pidgen refused that name as taken. Setup started nothing. Run it again with the name its fix offers, `pidgen setup --label <name>-2`, or without `--label` to be asked for one. |
| `ENROLL_FAILED`, `WORKER_HOST_TAKEN` or another failure after the enrollment was created | `pidgen worker enroll` and setup withdraw the enrollment they created (`DELETE /api/v1/workers/enrollments/{enrollment_id}`) before they exit, so it does not wait for 24 hours holding a worker slot, and report the failure with its own code and exit code. `error.details.withdrawn` is `true` and the message ends `The enrollment <id> was withdrawn.` When the withdraw itself fails, `withdrawn` is `false`, `error.details.withdraw_error` says why, and the enrollment expires on its own after 24 hours. |
| `This install's worker <name> is still listed but its credential is missing.` during setup | This install's worker home no longer holds the credential (`worker.env`) of the worker the Account lists under its install id, `~/.pidgen/install-id`. Setup asks `Replace <name>?` instead of enrolling a second worker beside it. Yes: remove `<name>` on the Workers page, then answer yes to `Removed <name> on the Workers page?`; setup reads the list again and, once it lists the worker as removed, enrolls this install under that name. No: setup suggests a new name (`<name>-2`). |
| `ENROLL_FAILED` naming `pidgen feedback` | The worker's home holds no credential after enrolling (`worker.env` has no `PIDGEN_NODE_TOKEN`), so setup did not start it. That is a setup bug: report it with `pidgen feedback --kind not-working`. |
| Setup suggests a name such as `my-host-2` | The Account already lists a connected or enrolled worker under this machine's host name that is not this install's (for example one that keeps its settings in another folder). Setup never adopts it: press Enter to accept the free name, type another, or pass `--label`. |
| `WORKER_EXITED` or `WORKER_NOT_CONNECTED` | Inspect `error.details.log_tail` or the reported log path. Run `pidgen worker doctor`, fix the reported issue, and rerun setup. |
| Status is successful but the worker is unavailable | Check `data.running`, `data.server`, and `data.warnings`. A successful status command does not guarantee a running or connected worker. |

### Enrollment states

Setup decides how to enroll a machine from the state it finds: what `~/.pidgen/worker.env` and
`~/.pidgen/install-id` hold, and what the Account lists on the Workers page. Each state is a row of
the enrollment state table, and each row has a setup test named by its number
(`tests/commands/setup.test.ts`, `enrollment states`). These are the rows a person can meet, with
the command that gets past each:

| State | What you see | Why | Fix |
|---|---|---|---|
| Removed worker's credential (row 3) | `This machine's worker was removed from <Account>. Enroll it again?`, or a worker that starts and never connects (`WORKER_NOT_CONNECTED`) | The worker was removed on the Workers page; `worker.env` still holds its revoked credential, which Pidgen refuses (HTTP 401). | Run `pidgen setup` and answer yes: the credential is moved aside to `worker.env.replaced-<UTC timestamp>` and one new enrollment is redeemed. Without setup: `pidgen worker enroll --replace-credential && pidgen worker start --detach`. See [Re-enroll a removed worker](#re-enroll-a-removed-worker). |
| Name held only by a removed worker (row 4) | Setup suggests the name of a worker the Workers page shows as removed | A removed worker no longer holds its name in the Account, so this machine may take it. | Press Enter at `Worker name`, or run `pidgen setup --label <name>`. A server that does not yet let an Account reclaim a removed worker's name refuses it with `WORKER_HOST_TAKEN`; setup then asks again with the next free name. |
| Name held by a live worker of the Account (row 6) | `<Account> already has a worker named <name> (connected; enrolled <date>).` and the suggestion `<name>-2` | Another worker of this Account, another machine or another worker home on this one, holds the name. Setup never adopts it. | Press Enter to take `<name>-2`, or run `pidgen setup --label <another name>`. To reuse the name, remove that worker on the Workers page first, then run `pidgen setup`. |
| Credential for another server (row 7) | `WORKER_CREDENTIAL_PRESENT` at setup's `enroll` step: `~/.pidgen/worker.env holds a worker credential for <server>.` | `worker.env` belongs to a worker enrolled with another Pidgen server. `pidgen-worker` refuses to replace another server's credential, so setup created no enrollment. | Move it aside and run setup again: `mv ~/.pidgen/worker.env ~/.pidgen/worker.env.old && pidgen setup`. To keep that worker as well, give this one its own home: `PIDGEN_HOME=~/.pidgen-<name> pidgen setup`. |
| Credential lost, this install's worker live (row 10) | `This install's worker <name> is still listed but its credential is missing.`, then `Replace <name>?` | `worker.env` was deleted or moved, but `~/.pidgen/install-id` shows the Account still lists this install's worker live. | Run `pidgen setup` and answer yes, remove `<name>` on the Workers page, then answer yes to `Removed <name> on the Workers page?`: setup enrolls this install under `<name>` again. Answer no to enroll it under a new name instead. |
| Name held by another person's pending enrollment (row 11) | `▲  <name> is taken in Pidgen, so this worker needs another name.`, the setup log reading `HTTP 409 WORKER_NAME_TAKEN` | Someone in the Account created an enrollment under that name that no worker has redeemed yet. The Account's list does not show pending enrollments, so only the server's refusal does. Nothing was created. | Accept the name setup offers (the server's `suggested_name`), or run `pidgen setup --label <suggested_name>`. To use the name itself, ask that person to finish or withdraw their enrollment; an unused one expires after 24 hours. |
| Copied worker home (row 13) | Setup on a second machine says `Already set up` or `<name> is enrolled; skipping the enrollment.`, and one entry on the Workers page stands for two machines | `~/.pidgen` was copied from another machine (a cloned virtual machine, a restored backup, a synced home directory), so both hold the same credential, host id and install id. Setup cannot tell the copy from the original. No setup test covers it. | On the copy only, stop its worker, move its credential and install id aside, and enroll it under its own name: `pidgen worker stop && mv ~/.pidgen/worker.env ~/.pidgen/worker.env.copied && mv ~/.pidgen/install-id ~/.pidgen/install-id.copied && pidgen setup --label <new name>`. If setup on the copy asks `Replace <name>?`, answer no: yes would replace the original machine's worker. |

### Re-enroll a removed worker

When a worker is removed on the Workers page, its machine keeps the revoked credential in
`~/.pidgen/worker.env`. `pidgen-worker` uses a saved credential instead of exchanging a new
enrollment, so a worker started with it is refused by the server and never connects.

Run `pidgen setup` again. It sees the worker removed from the Account and asks
`Enroll it again?`. Yes runs `pidgen worker enroll --replace-credential`, which moves `worker.env`
aside to `worker.env.replaced-<UTC timestamp>` (kept, mode 0600; the setup log names it) before
creating the enrollment, so the worker redeems the new enrollment, starts with its new credential
and connects. Setup ends with `Worker running and connected to Pidgen as <name> (<id>)`.

Without setup, run `pidgen worker enroll --replace-credential`, then `pidgen worker start --detach`.
With a CLI older than the flag, move the file aside yourself:
`mv ~/.pidgen/worker.env ~/.pidgen/worker.env.revoked && pidgen setup`.

Manual check (test bed): after a completed `pidgen setup`, remove the worker on the Workers page,
then run `pidgen setup` again and answer yes to `Enroll it again?`. It ends with the worker running
and connected, the Workers page lists it connected again, the enrollment setup created is consumed,
and `~/.pidgen` holds the moved `worker.env.replaced-<UTC timestamp>`.

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
