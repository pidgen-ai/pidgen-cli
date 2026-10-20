# Skills

For a first installation and an example agent task, follow [Install agent skills](install-skills.md).
This reference lists the bundled skills, installation options, and status behavior.

Pidgen ships **agent skills**: instructions that teach a coding agent (Claude Code, Codex, pi) how to
file, plan, and recover Pidgen work with the `pidgen` CLI. They live in [`skills/`](../skills) and are
bundled in the npm package, so every CLI release carries the skills written for its commands.

## The skills

Every skill's name starts with `pidgen-`, so it does not collide with another tool's skill in a
shared skills directory such as `~/.claude/skills`.

| Skill | Use it to |
|---|---|
| `pidgen-file-ticket` | Submit a prose intent and answer its clarification questions, or file one structured ticket as a manifest with no children; or file a request instead when someone outside the team asked, the work is not yet judged worth doing, or its target is unclear |
| `pidgen-manage-epics` | Create an Epic (an epic-kind ticket), set its branch and merge policy, place tickets in it by `parent_ticket_id`, and wire dependency edges; file a Domain Epic in a domain for work across projects and place each project's work under it |
| `pidgen-decompose-plan` | Turn related work into parent/child delivery cohorts and file each new cohort as one ticket manifest; for work across projects, file one cohort per project under one Domain Epic and link each root to the contract it implements or builds against |
| `pidgen-manage-contracts` | Put an interface between projects into Pidgen as files: choose publish, propose, attach or link; publish a spec file with `pidgen contract publish` after `--check`, stopping for a breaking change; propose a fragment file with `pidgen contract propose`; set up CI (publish on the default branch, `--check` on pull requests, the token a secret); read landed and pending operations; never write a schema into a command, a body or a ticket |
| `pidgen-triage-requests` | Work the request queue: list new requests, read each with its timeline, acknowledge it or ask the requester, accept it (with a bug's details or the missing ones unknown), close it with a reason, or promote it to a ticket in a Project |
| `pidgen-query-tickets` | Find and read tickets, Epics, runs, and their state |
| `pidgen-retry-run` | Decide whether a failed or stalled run should get a fresh attempt, and start it |
| `pidgen-replay-node` | Re-run one workflow node as a new attempt, including reopening a completed ticket |
| `pidgen-unstick-ticket` | Choose between answering a clarification, retrying, or filing new work |
| `pidgen-setup-worker` | Diagnose setup, install and verify a worker, check new model or coding-agent support, resize pools and session caps, customize documented harness options, and configure multiple provider subscriptions using the published documentation |
| `pidgen-project-readiness` | Get a Project's repository ready for its Tickets: read the findings and answer the questions, write the proposed `.pidgen/` setup or open it as a pull request, rehearse it on a worker; later ask the Project doctor whether the setup is why work fails, and propose its fix |
| `pidgen-setup-workspace` | Make a repository's tests pass in isolated ticket workspaces: list what the tests need, give each workspace its own services, ports, installs and settings with a tracked `pidgen.toml` and its `provision`, `activate` and `teardown` hooks, rehearse the hooks as a worker runs them, and diagnose a failed run's hook errors |

For worker help, ask your agent to use `pidgen-setup-worker`, for example: “Diagnose why my worker
is disconnected,” “Check whether this worker can run this new model,” “Raise Claude's session cap
to four,” “Configure a documented harness option,” or “Add a second provider subscription.”
The skill starts from [Pidgen Docs](https://docs.pidgen.ai/), selects the relevant CLI or worker
guide, checks installed versions, and verifies changes through status, doctor and configuration
readback. [Use a new model on a worker](worker-models.md) covers readiness, executable selection
and model input capabilities; [Worker policy](worker-policy.md) lists the versioned options.
The skill reports unsupported or undocumented model and policy options instead of guessing
configuration keys. Provider plan sizing hints are not guaranteed limits; automatic subscription
fallback depends on the Account's plan. Support reports are prepared locally and sent only when
you ask to submit them.

## Installing

```console
$ pidgen skills install                      # every supported agent, user scope
$ pidgen skills install --agent claude --scope project
$ pidgen skills status
```

| Flag | Values | Default |
|---|---|---|
| `--agent` | `claude`, `codex`, `pi`, `all` | `all` agents found on the machine |
| `--scope` | `user` (your home directory), `project` (the current repository) | `user` |
| `--force` | Overwrite skills you have edited | off |

Where each agent reads skills, under your home directory (`--scope user`) or the current directory
(`--scope project`). An agent counts as found when its directory exists in your home directory.

| Agent | Found by | Skills directory |
|---|---|---|
| Claude Code | `~/.claude` | `.claude/skills` |
| Codex | `~/.codex` | `.agents/skills` |
| pi | `~/.pi` | `.agents/skills` |

Codex and pi share `.agents/skills`, so the skills are written there once.

In human mode, installation reports distinct skills, destinations, agent coverage, and total
skill-destination records separately. Each destination lists its agents and each skill's outcome:
`installed`, `updated`, `unchanged`, or `skipped edited`. Skipped locally edited copies are preserved;
`--force` overwrites them. For example, 10 skills copied to two destinations serving three agents
produce 20 records, not 20 distinct skills. JSON mode retains the original installation records
(including the `skipped_edited` action).

Skills are **copied**, not linked, because a link into an `npx` cache breaks when the cache is
cleaned. Each installed `SKILL.md` gets two frontmatter fields:

```yaml
pidgen-cli-version: 0.1.0-alpha.1
pidgen-skill-hash: sha256:…
```

`pidgen skills status` compares installed copies with the running CLI's bundled skills and reports each
one in `data.skills` as `current`, `stale` (its bundled content has changed), `edited` (its content no
longer matches its hash), or `missing`. The skills call `pidgen` commands built against the CLI's
committed API contract, so `data.contract` also says whether that contract matches the configured
server's published one (`GET /api/v1/openapi.json`, read without a credential): `state` is `same`
or `different` (comparing `info.version` and a `sha256:` digest of each document with its keys
sorted, in `cli` and `server`), with the operations only the CLI's (`only_in_cli`) or only the
server's (`only_on_server`) contract has. With no server configured it reads the hosted server's,
`https://api.pidgen.ai`. When the server's cannot be read, `state` is `unchecked` and `reason`
says why (`NETWORK`, the server's refusal code);
the command still exits 0. `pidgen skills install` updates stale copies and skips edited ones unless
`--force` is given.

In human output, `skills status` shows each skill's destination, agents and state in labeled
sections. It also says **Contract differs** or **Contract unchecked** when applicable, retaining
the differing operations or the supplied failure code and reason alongside the skill results.
These qualifications still exit 0; they do not imply the contract was verified. Use
`pidgen skills status --format json` to read the complete structured report.

The bundled skills pass `--format json` on every command whose output they read, in a terminal too:
terminal stdout otherwise defaults to human-readable output. They call only `pidgen` commands,
preview before they apply, and never name an Account, profile or server; the profile decides.

## What each skill uses

| Skill | Commands |
|---|---|
| `pidgen-file-ticket` | `project list\|show`, `intent submit\|respond`, `manifest template\|apply`, `ticket edit\|show\|types`, `request submit` |
| `pidgen-manage-epics` | `project list`, `domain list\|epics\|project add`, `ticket create\|list\|show\|edit --kind epic`, `ticket create --kind epic --domain`, `ticket move\|dep add\|dep rm\|dep list\|show\|actions\|act`, `epic create\|dag show\|edge add` (and `epic create --domain`) |
| `pidgen-decompose-plan` | `manifest template\|apply`, `plan show\|apply\|promote\|template\|cohorts`, `project show`, `ticket dep add\|edit\|show\|types`, `domain epics`, `contract list\|show\|accept`, `ticket contract implements\|builds-against` |
| `pidgen-manage-contracts` | `contract list\|show\|publish\|propose\|revise\|accept`, `ticket contract implements\|builds-against` |
| `pidgen-triage-requests` | `request list\|show\|reply\|acknowledge\|accept\|close\|promote`, `project list`, `ticket show\|types` |
| `pidgen-query-tickets` | `ticket list\|show\|dep list\|actions` (with `--kind epic`), `project list\|show`, `epic list\|show\|dag show`, `run list\|show\|node-output`, `review list\|attention` |
| `pidgen-retry-run` | `ticket show\|actions\|act\|retry\|edit`, `run list\|show\|node-output`, `review attention`, `worker status` |
| `pidgen-replay-node` | `ticket show\|actions\|act\|replay\|reopen`, `run list\|show\|node-output`, `review attention`, `worker status` |
| `pidgen-unstick-ticket` | `review list\|attention`, `ticket clarify\|actions\|act\|template\|create\|cancel`, `run list\|show`, `worker status`, `api get` |
| `pidgen-project-readiness` | `project inspect\|setup\|rehearse\|doctor`, `ticket show\|act` |
| `pidgen-setup-worker` | `doctor`, `auth login`, `account use`, `worker install\|verify\|enroll\|start\|stop\|restart\|status\|doctor\|login\|update\|uninstall\|subscriptions`, `skills install`, `feedback` when requested; and the installed worker's `pidgen-worker capacity show\|set\|reload` and `pidgen-worker subscriptions show\|use` |
| `pidgen-setup-workspace` | `project list\|show`, `run list\|show\|node-output`; everything else is the repository's own tooling |

The recovery skills (`pidgen-retry-run`, `pidgen-replay-node`, `pidgen-unstick-ticket`) recover only with
`pidgen ticket actions` and `pidgen ticket act` (or `pidgen ticket retry` and `pidgen ticket replay`, which
use the same routes), and cover choosing `restart_refinement` (the refinement re-dispatch, for a
ticket at `research_needed`, `specification` or `planning`) versus `replay_from_node`, and
`resolve_target_conflict`.

`pidgen-manage-epics` and `pidgen-decompose-plan` file work that spans projects under a **Domain Epic**, an Epic
filed in a domain with `pidgen ticket create --kind epic --domain` that owns no branch, and place
each project's work under it by `parent_ticket_id` (a manifest's `epic_id`). `pidgen-decompose-plan` files
one cohort per project, finds the interface with `pidgen contract list` and `pidgen contract show`,
and after each commit links the provider's root with `pidgen ticket contract implements` and each
consumer's root with `pidgen ticket contract builds-against`, naming the operations it uses.

A contract is never required for work that spans projects. `pidgen-decompose-plan` and `pidgen-file-ticket`
carry the provider's interface into the consumer ticket one of three ways: attach the spec file to
the ticket, state the interface in its scope, or link a contract, reusing one or creating one with
`pidgen-manage-contracts` when the interface is shared by several pieces of work or will change.
`pidgen-manage-contracts` finds an existing contract first, then puts the interface in as files:
it publishes a spec file that describes existing code with `pidgen contract publish`, running
`--check` first and stopping to ask the person before a breaking change, and proposes an interface
that does not exist yet from a fragment file holding only the operations needed with
`pidgen contract propose`. It never writes a schema into a command, a body or a ticket. With the
person's agreement it sets up CI (`.github/workflows/`, `.gitlab-ci.yml`, or the repository's own
CI workflow directory): publish on pushes to the default branch and `--check` on pull requests,
with `PIDGEN_TOKEN` a secret. It reads each operation's state with `pidgen contract show`, covers
every refusal code of the publishing routes, keeps `pidgen contract revise` for prose revisions, and links work to the
contract. `pidgen-decompose-plan` adds the pending rule: a root that builds against a
pending operation builds against a mock of it in its own workspace. No skill asks a person to approve a
contract: linked work waits only when the Account's Contract approval setting asks for a person
([contract](commands.md#contract)).

`pidgen-file-ticket` files a **request** with `pidgen request submit` rather than a ticket when
someone outside the team asked for the work, it is not yet judged worth doing, or its target is
unclear; for a bug it gives the steps, expected and actual results (`--steps`, `--expected`,
`--actual`) and attaches evidence files with `--evidence`. `pidgen-triage-requests` works the queue:
`pidgen request list --state new`, `pidgen request show`, then `acknowledge` or `reply --ask`,
`accept` (with `--unknown` for a bug's missing details), `close --reason` (with `--duplicate-of`
or `--note`) or `promote` into the Project the request targets. Triage acts directly, with no preview
([request](commands.md#request)).

Every skill is written for the commands of the CLI release it ships with. After upgrading the CLI,
run `pidgen skills install` again so the installed copies match ([Installing](#installing)).
