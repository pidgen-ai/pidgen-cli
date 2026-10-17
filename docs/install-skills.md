# Install agent skills

Pidgen's agent skills teach your coding agent to use the `pidgen` CLI to file, plan, follow, and
recover work. Install them after [installing the CLI and signing in](getting-started.md).
Installing skills copies local files; it does not require a worker or send work to Pidgen.

## 1. Choose your coding agent

Use the command for your agent:

| Coding agent | Install for your user |
|---|---|
| Claude Code | `pidgen skills install --agent claude` |
| Codex | `pidgen skills install --agent codex` |
| pi | `pidgen skills install --agent pi` |

User scope is the default: your installed skills are available across repositories. The command
copies the complete bundled set and reports, for each destination, the agents it serves and each
skill's outcome, such as `installed` or `unchanged`. With `--format json`, `data` lists each
skill's destination (`dir`) and `action`.

If you use several agents, `pidgen skills install` installs for all agents whose marker
directories exist in your home directory. If none is detected, choose `--agent` explicitly from
the table. Explicit selection also works before the agent has created its marker directory.

## 2. Verify the installation

Use the same agent selection you installed with. For Codex:

```sh
pidgen skills status --agent codex
```

Check that every skill is `current` (`data.skills[].state` with `--format json`). This verifies
the files against the skills bundled with your running CLI. The command also compares the CLI's
API contract with the server's (`data.contract`); `unchecked` means that check could not
complete, while `different` means the server's contract differs. Neither means the local skill
copies are missing.

Start a new agent session in your repository so the agent can discover the installed skills.
If it does not see them, check its skill list and the destination reported by the install
command. See [Skill troubleshooting](troubleshooting.md#agent-skills).

## 3. Try a skill

In your coding agent, ask:

> Use pidgen-query-tickets to list my Pidgen projects and show any work that needs my attention.

This gives you a first read-only task. Your agent needs access to the `pidgen` command and your
signed-in profile in its environment. Run `pidgen auth status` in that environment if it cannot
authenticate.

When you are ready to file work, give the agent an outcome and a project:

> Use pidgen-file-ticket to draft a ticket for project EXAMPLE to improve the sign-in error
> messages. Show me the title, objective, and acceptance criteria before submitting it.

Replace the project and task with your own. This is an instruction to your coding agent to let
you review its draft; `ticket create` and `intent submit` themselves create or submit work
immediately. Commands that support preview/apply must follow that flow. See the
[skill catalog](skills.md#the-skills) for planning, recovery, and worker setup skills.

## Install for one repository

Run from the repository root and select project scope:

```sh
pidgen skills install --agent codex --scope project
pidgen skills status --agent codex --scope project
```

Replace `codex` with `claude` or `pi` as needed. Project scope writes beneath the current
directory; it does not search for the repository root. Use it when skills should travel with
the repository, and review the copied files before committing them.

| Agent | User-scope directory | Project-scope directory |
|---|---|---|
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Codex | `~/.agents/skills` | `.agents/skills` |
| pi | `~/.agents/skills` | `.agents/skills` |

Codex and pi share a destination, so the CLI copies their skills only once when both are selected.

## Keep your skills current

After updating the CLI, run the install command again for each agent and scope you use:

```sh
npm install -g pidgen@alpha --ignore-scripts
pidgen skills install --agent codex
pidgen skills status --agent codex
```

The installer updates stale copies and keeps current ones. It skips copies you edited, reporting
`skipped_edited`; status reports them as `edited`. Review and back up those edits before choosing
`--force`, which overwrites them with the bundled version.

Next: [Install and connect a worker](install-worker.md) to execute work on your machine, or return
to [Create your first ticket](getting-started.md#create-your-first-ticket).
