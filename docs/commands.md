# Commands

New to the CLI? Start with [Get started with Pidgen](getting-started.md). This page is the
reference for commands, flags, input files, and their public API routes.

`pidgen <noun> <verb> [arguments] [flags]`, in the style of `gh`. Every command below is available
unless it is marked *planned*. `auth status` and `account list` ask the server who you are
(`GET /me`) when the credential in use is a CLI token; `auth logout` and `account use` work on the
local configuration only, and their server-backed parts are marked *planned* below.

Terminal stdout defaults to human-readable output; nonterminal stdout defaults to the JSON envelope.
`--format json` and `--format table` override this, including errors. JSON fields and exit codes stay
unchanged. Help/version print text; foreground `pidgen worker start` inherits the worker's streams
and status. See [Output and exit codes](output-and-exit-codes.md). Commands with side effects follow
[Preview and apply](preview-and-apply.md).

Resource reads in human output identify collections and displayed counts, label detail sections,
and retain multiline content. Tables adapt to terminal width with complete actionable values.
Use `--format json` for every field in the response; see
[resource read output](output-and-exit-codes.md#resource-reads-in-human-output).

Mutation responses label unapplied previews, settled applications, pending operations and timed-out
waits, retaining requirements, created keys and follow-up details. Direct writes retain their
existing mutation policy. See [human-readable mutation results](preview-and-apply.md#human-readable-mutation-results)
for presentation and application examples; select `--format json` for structured results.

## Global flags

| Flag | Meaning |
|---|---|
| `--profile <name>` | Use a named profile instead of the default ([Authentication](authentication.md)) |
| `--account <ACC-…>` | Use the stored credential for another Account for this command |
| `--format json\|table` | Output format; automatic default is `table` for terminal stdout, `json` otherwise |
| `--timeout <seconds>` | Network, `--wait`, and `worker stop` and `worker restart` timeout |
| `-h, --help` | Help for any command |
| `-V, --version` | CLI version and supported API version range |

## Input files

`-f <file>` takes a request body as JSON or YAML: `.json` files are JSON, `.yaml` and `.yml` files
are YAML, and anything else, including standard input (`-f -`), is JSON when it starts with `{` or
`[` and YAML otherwise. YAML uses the 1.2 core schema, so a YAML file and a JSON file with the same
content give the same body. Duplicate keys are refused.

Before sending, the CLI validates the body against the operation's request schema in the committed
public API document, resolving local `$ref`s. Any failure exits 2 with `INPUT_INVALID`:

- a syntax error has `error.details` `{source, format, line, column, reason}`, and the message
  names the line and column;
- a body that does not match the schema has `error.details.issues`, one `{path, message}` per
  problem, where `path` locates it in the body (`$` is the whole body, e.g.
  `$.acceptance_criteria[1].statement`).

The CLI sends the body as written; it does not add defaults or drop fields the schema does not name.
The three additions are `pidgen ticket edit`'s, which sends the ticket's current `version` with the
file's fields, `pidgen ticket clarify`'s, which sends the open clarification's `gate_generation`
when the file names none, and `pidgen request submit`'s, which sends a generated `submission_key`
when the file and flags name none.

## Command tree

```text
auth      login | logout | status | list | revoke
account   list | use
project   list | show | inspect | setup | rehearse
domain    list | show | create | edit | archive | unarchive | epics   ·   project add|rm   ·   parent add|rm
          member add|rm   ·   maintainer add|rm
contract  list | show | create | publish | propose | revise | accept
ticket    list | show | create | edit | cancel | actions | act | retry | replay | reopen | clarify
          template | types | owner | follow | unfollow | instructions | history   ·   dep add|rm|list   ·   move --epic
          contract implements|builds-against|rm
intent    submit | respond | list | show | withdraw
request   submit | list | show | reply | acknowledge | accept | close | promote
session   steer | instructions | edit-instruction | withdraw-instruction
epic      list | show | create | edit   ·   dag show   ·   edge add|rm   (aliases of ticket commands)
plan      show | apply | promote | template | cohorts
manifest  template | apply
review    list | attention
run       list | show | node-output
worker    install | verify | update | uninstall | enroll | start | stop | status | doctor | login | subscriptions   ·   subscriptions use
skills    install | status
feedback  (one command: pidgen feedback --kind … <message>)
setup     (one command: pidgen setup; the one interactive command)
doctor    (one command: pidgen doctor)
api       get | post | put | patch | delete
```

Routes below are paths on the public API under `/api/v1`. `{ref}` is a ticket key such as
`PIDGEN-12`; the Account comes from the credential.

## auth

| Command | Does | Route |
|---|---|---|
| `pidgen auth login [<url>] [--device-label <name>]` | Device-code login for one Account; verifies the CLI token and stores it in the profile | `GET /health`, `POST /auth/device`, `POST /auth/device/token`, `GET /me` |
| `pidgen auth login [<url>] --with-token --account <ACC-…>` | Verifies a Personal API Token read from standard input and stores it as the profile's credential for that Account | `GET /health`, `GET /projects` |
| `pidgen auth logout [--account <ACC-…>]` | Forgets the profile's credential for the current or named Account. *Planned:* revoking it on the server | — (*planned:* `DELETE /me/sessions/{session_id}`) |
| `pidgen auth status [--check]` | Who you are (the User, the Account and your role, with a CLI token), the profile, server, Account, credential kind and expiry, and the cached server check; `--check` re-checks the server | `GET /me` with a CLI token, `GET /health` with `--check` |
| `pidgen auth list` | Your browser sessions and CLI tokens, marking the credential in use. Refuses a Personal API Token | `GET /me/sessions` |
| `pidgen auth revoke <id>` | Revokes one session or CLI token; revoking the credential in use also removes it from the profile. Refuses a Personal API Token | `DELETE /me/sessions/{session_id}` |

`pidgen login` is an alias for `pidgen auth login` (*planned*).

`GET /me`, `GET /me/sessions` and `DELETE /me/sessions/{session_id}` are in the committed public API
document. `auth login`, `auth status` and `account list` use `GET /me`; `auth list` uses
`GET /me/sessions` and `auth revoke` uses `DELETE /me/sessions/{session_id}`. These routes are not Account-scoped: they ignore the selected Account and act for the
signed-in User. `GET /me` answers the User, every Account they are an active member of, and — for a
CLI token — that token's `token_id` and Account (`cli_token`, `null` otherwise). `GET /me/sessions`
lists browser sessions and CLI tokens (`kind` `session` or `cli_token`, `current` marking the
credential in use) and never a token secret. `DELETE /me/sessions/{session_id}` revokes one at once;
a CLI token may revoke itself to sign out. A Personal API Token is refused on all three with
`TOKEN_NOT_ALLOWED` (exit code 3).

### auth login

```console
$ pidgen auth login https://pidgen.example.com [--device-label laptop]
Open https://pidgen.example.com/device and enter the code  WDJB-MJHT
Waiting for approval…
```

- `<url>` is the server to sign in to. Without it, the login uses `PIDGEN_API_URL`, else the
  profile's server, else the hosted server, `https://api.pidgen.ai`.
- Before anything else, checks `GET /health` without a credential, as `--with-token` does: `NOT_PIDGEN`
  (exit code 1) or `API_VERSION_UNSUPPORTED` (exit code 7), and nothing is written.
- Then starts a login with `POST /auth/device` (sending `--device-label`, 1–200 characters, when
  given) and writes the verification address and user code to standard error. The code is written
  there even when standard error is not a terminal, because a person has to read it; it is never on
  standard output. `Waiting for approval…` is written only on a terminal. The device code is never
  shown.
- Polls `POST /auth/device/token` every `interval` seconds from the server. `authorization_pending`
  keeps polling; `slow_down` grows the interval to the server's `error.details.interval`, or by five
  seconds when it gives none.
- `access_denied` (the login was denied in the web app), `expired_token` (the code expired, including
  when `expires_in` passes without an answer) and `invalid_grant` fail with that `error.code` and
  exit code 3. Nothing is written.
- On approval, verifies the new CLI token before storing it: `GET /me` with the token (and no
  Account, since `/me` is not Account-scoped) must answer `200`. Any refusal fails the login with the
  server's `error.code` — `TOKEN_INVALID` (exit code 3) for a token the server does not accept — and
  a message saying nothing was stored; `error.details.stored` is `false`. When the answer's
  `cli_token.account_id` names a different Account from the one approved, the login fails with
  `ACCOUNT_MISMATCH` (exit code 3). Nothing is written in either case.
- Then stores the CLI token as a `cli` credential for the Account chosen in the web app, with
  its `token_id` and `expires_at` (the sooner of its idle and absolute expiry), in the profile
  (`--profile`, `PIDGEN_PROFILE`, or the default profile), as `--with-token` does: the file is written
  with mode `0600`, the Account becomes the profile's default if it had none, and credentials for a
  different server are dropped.
- `--account` is a usage error (`CLI_USAGE`, exit code 2): you choose the Account when you approve.
- `data`: `profile`, `url`, `account`, `credential_kind` (`"cli"`), `token_id`, `device_label`,
  `expires_at`, `absolute_expires_at`, `verified` (`true`), and `server` (`service` and
  `api_version`). The token is never printed.

### auth login --with-token

```console
$ pidgen auth login https://pidgen.example.com --with-token --account ACC-EXAMPLE < token.txt
```

- Reads the token from standard input and trims surrounding whitespace. `--account` is required,
  because a token is bound to one Account. A missing `--account`, an empty token, or a URL that is
  not `http(s)` is a usage error (`CLI_USAGE`, exit code 2).
- Before storing anything, checks `GET /health` without sending the token: a server that is not Pidgen
  is refused with `NOT_PIDGEN` (exit code 1), and one whose API version range does not include the
  CLI's with `API_VERSION_UNSUPPORTED` (exit code 7). Nothing is written in either case.
- Then verifies the token before storing it. A Personal API Token is refused on `/me*` by design, so
  the CLI calls `GET /projects` with the token and `X-PIDGEN-Account` set to `--account`:
  - `200` — the token is valid for the Account;
  - `403` `TOKEN_SCOPE_NOT_GRANTED` — the token is valid but lacks `tickets:read`; it is still
    stored, and `data.scope_limitation` reports it;
  - `401` `TOKEN_INVALID` (the token is wrong, revoked or expired) or `403` `ACCOUNT_MISMATCH` (it
    is bound to another Account) — the login is refused with that `error.code` and exit code 3;
  - any other refusal or failure keeps the server's `error.code` and its exit code
    ([Output and exit codes](output-and-exit-codes.md)).

  A refused login writes nothing: the message says so and `error.details.stored` is `false`.
- Then stores the token as a `pat` credential for the Account in the profile (`--profile`,
  `PIDGEN_PROFILE`, or the default profile), sets the profile's URL and server check, and makes the
  Account the profile's default if it had none. The file is written with mode `0600`. If the profile
  pointed at a different server, its credentials for that server are dropped, so they are never
  sent to the new one.
- `data`: `profile`, `url`, `account`, `credential_kind` (`"pat"`), `verified` (`true`),
  `scope_limitation`, and `server` (`service` and `api_version`). `scope_limitation` is `null` when
  `GET /projects` answered `200`, and otherwise `{code, missing_scope, message}`: `code` is
  `TOKEN_SCOPE_NOT_GRANTED`, and `missing_scope` is the scope the server names in its error details
  (`missing_scope` or `required_scope`), or `tickets:read` when it names none. Other scopes are not
  checked. The token is never printed.

### auth status

```console
$ pidgen auth status [--check]
```

- Reads the selected profile (`--profile`, `PIDGEN_PROFILE`, or the default profile) and Account
  (`--account`, `PIDGEN_ACCOUNT`, or the profile's default), honouring `PIDGEN_API_URL` and
  `PIDGEN_TOKEN`.
- With a CLI token (a stored `cli` credential, or a `PIDGEN_TOKEN` starting `pidgen_cli_` or `awes_cli_`), asks the
  server who you are: `GET /me` with the token and no Account, since `/me` is not Account-scoped.
  A refusal keeps the server's `error.code` and exit code — `TOKEN_INVALID` (exit code 3) for a
  revoked or expired token — and an answer that does not match the public API document is
  `UNEXPECTED_RESPONSE` (exit code 1). `meta.request_id` and `meta.api_version` are the answer's.
- With a Personal API Token, which the server refuses on `/me` by design, or an `PIDGEN_TOKEN` of
  unrecognised kind, it reports the local profile only and makes no network call unless `--check` is
  given; `data.identity_note` says why.
- `--check` first re-runs the server check (`GET /health`, without the credential), as `auth login`
  does: `NOT_PIDGEN` (exit code 1) or `API_VERSION_UNSUPPORTED` (exit code 7) on failure. The result is
  shown but not stored.
- No credential for the Account: `AUTH_REQUIRED` (exit code 3), with `error.details.hint` naming
  the login command. It makes no network call.
- `data`: `profile`, `url`, `account`, `default_account`, `credential_kind` (`"pat"`, `"cli"`, or
  `null` for an unrecognised `PIDGEN_TOKEN`), `credential_source` (`"config"` or `"environment"`),
  `expires_at` (`null` when unknown), `server` (`service`, `api_version`, `checked_at`; the check
  stored at login, the fresh one with `--check`, or `null`), `identity` and `identity_note`. The
  token is never printed.
  - `identity`, from `GET /me` with a CLI token: `user` (`user_id`, `email`, `display_name`),
    `account` (the Account the token is bound to, `cli_token.account_id`, or the selected Account
    when the answer names none), `account_name` and `role` (`owner`, `administrator` or `member`)
    from your membership of that Account (`null` when `GET /me` does not list it), and `token_id`.
    `null` when `GET /me` was not called.
  - `identity_note`: `null` with a CLI token; otherwise why only the local profile is shown — for a
    Personal API Token, that the server does not describe Personal API Tokens on `GET /me`.

### auth logout

```console
$ pidgen auth logout [--account ACC-EXAMPLE]
```

- Removes the stored credential for the Account named with `--account`, or else the current Account
  (`PIDGEN_ACCOUNT`, then the profile's default), from the selected profile. If the profile's default
  Account was that Account, the default is cleared. No network call is made.
- No credential stored for that Account: `CREDENTIAL_NOT_FOUND` (exit code 4); nothing is written.
- `data`: `profile`, `account`, `removed` (`true`), `revoked` (`false`: the token stays valid on the
  server; revoke a Personal API Token in the web app), and `default_account` (after the change, or
  `null`).
- *Planned:* revoking a CLI token on the server (`DELETE /me/sessions/{session_id}`, published).
  Until then, `pidgen auth revoke <id>` revokes it and removes it from the profile.

### auth list

```console
$ pidgen auth list
```

- Lists your live browser sessions and CLI tokens with `GET /me/sessions`, sending the credential in
  use (`PIDGEN_TOKEN`, or the stored credential for `--account`, `PIDGEN_ACCOUNT` or the profile's
  default) and no Account, since the route is not Account-scoped: it lists your tokens for every
  Account. The order is the server's: sessions first, each most recently used first.
- A Personal API Token (a stored `pat` credential, or a `PIDGEN_TOKEN` starting `pidgen_pat_` or `awes_pat_`) is
  refused before any network call with `TOKEN_NOT_ALLOWED` (exit code 3); `error.details.hint` says
  Personal API Tokens are listed and revoked in the web app. A token of unrecognised kind is sent,
  and the server's `TOKEN_NOT_ALLOWED` gains the same hint.
- No credential: `AUTH_REQUIRED` (exit code 3), with no network call.
  Other refusals keep the server's `error.code` and exit code — `TOKEN_INVALID` (exit code 3) for a
  revoked or expired token — and an answer that does not match the public API document is
  `UNEXPECTED_RESPONSE` (exit code 1).
- `data` is an array, one entry per session or token: `id` (what `pidgen auth revoke` takes), `kind`
  (`session` or `cli_token`), `account` (the Account a CLI token is bound to; `null` for a
  session), `device_label` (the browser and platform, or the name given at login; may be `null`),
  `created_at`, `last_used_at`, `expires_at` (a CLI token's; `null` for a session), `current`
  (`true` for the credential making the request), `mfa_verified`, and `stored_account` (the Account
  this profile stores that CLI token for, matched by `token_id`, or `null`). No token secret is
  listed.

### auth revoke

```console
$ pidgen auth revoke tok-example
```

- Revokes one of your browser sessions or CLI tokens by the `id` `pidgen auth list` shows, with
  `DELETE /me/sessions/{session_id}` (the id percent-encoded as one path segment, no Account sent).
  It stops working at once. The server has no preview for revocation, so the command acts directly
  ([Preview and apply](preview-and-apply.md)).
- When the server answers that the revoked credential was the one in use (`current`), every
  credential in the selected profile holding that token is removed, and so is any stored CLI token
  whose `token_id` is `<id>`, even when it was not in use; the profile's default Account is cleared
  if it pointed at a removed one. Nothing else in the profile changes, and a refusal writes nothing.
- A Personal API Token is refused before any network call with `TOKEN_NOT_ALLOWED` (exit code 3),
  as for `auth list`, with the same hint. A missing, blank, `.` or `..` id is a usage error
  (`CLI_USAGE`, exit code 2). `SESSION_NOT_FOUND` (exit code 4) means none of your sessions or
  tokens has that id. Other refusals keep the server's code and exit code.
- `data`: `id`, `revoked` (`true`), `current` (whether it was the credential in use), `profile`,
  `removed_from_profile` (the Accounts whose stored credential was removed, sorted; empty when none)
  and `default_account` (after the change, or `null`).

## account

| Command | Does | Route |
|---|---|---|
| `pidgen account list` | With a CLI token, every Account you belong to merged with the Accounts that have a stored credential in the profile; otherwise the stored Accounts only. Marks the default | `GET /me` with a CLI token |
| `pidgen account use <ACC-…>` | Makes an Account with a stored credential the profile default. *Planned:* starting a login if none is stored | — |

`account use` reads and writes the local configuration only and makes no network call.

- `pidgen account list` — when the credential in use (`PIDGEN_TOKEN`, or the stored credential for
  `--account`, `PIDGEN_ACCOUNT` or the profile's default) is a CLI token and a server is configured,
  calls `GET /me` with it (no Account is sent) and merges the Accounts you are an active member of
  with the Accounts the selected profile holds a credential for. Without a CLI token — a Personal API
  Token, which `/me` refuses by design, or no credential — it lists the stored Accounts only and
  makes no network call. A refusal from `GET /me` keeps the server's `error.code` and exit code, as
  for `auth status`.

  `data` is an array, one entry per Account, sorted by Account id:
  `{account, account_name, role, member, default, credential_stored, credential_kind, expires_at}`.
  `account_name` and `role` come from `GET /me` (`null` when it does not list the Account or was not
  called); `member` is `true` when `GET /me` lists the Account, `false` when it does not (a stored
  credential for an Account you no longer belong to), and `null` when the server was not asked;
  `default` is `true` for the profile's default Account; `credential_stored` says whether the
  profile holds a credential for it, whose `credential_kind` and `expires_at` follow (`null`
  otherwise). A profile with no credentials and no CLI token gives an empty array.
- `pidgen account use <ACC-…>` — sets the selected profile's default Account. `data`: `profile`,
  `account`, `previous_default`, `credential_kind`. When no credential is stored for the Account it
  fails with `AUTH_REQUIRED` (exit code 3), writes nothing, and `error.details.hint` names
  `pidgen auth login <url> --with-token --account <ACC-…>`. A missing Account id is `CLI_USAGE`
  (exit code 2).

## project

| Command | Does | Route |
|---|---|---|
| `pidgen project list` | Projects you can see in the Account | `GET /projects` |
| `pidgen project show <key>` | One project, including its merge policy | `GET /projects/{project_ref}` |

Both are read commands: one `GET` with the selected profile's credential and Account. `data` is the
server's `data` unchanged, and `meta` carries the server's `request_id` and `api_version` with the
profile and Account. A server refusal keeps its own `error.code` and exits with the code for its
status ([Output and exit codes](output-and-exit-codes.md)).

- `pidgen project list` — `data` is an array of projects, each with its `id` (`proj-…`), `name`,
  `prefix` (the ticket-key namespace), `merge_policy`, delivery settings and ticket `rollup`. An
  Account with no projects gives an empty array.
- `pidgen project show <key>` — `<key>` is the project's id or its ticket-key prefix (e.g. `Pidgen`);
  `data` is that one project, with the same fields, including its `merge_policy`. An unknown
  project, or another Account's, exits 4 with the server's `PROJECT_NOT_FOUND`. A missing, empty,
  `.` or `..` key, or more than one key, is `CLI_USAGE` (exit code 2) and sends nothing.

### project inspect, setup, rehearse and doctor

A Project's readiness says what its repository needs before a Ticket can work in it: Pidgen reads
the repository at the base branch, reports one finding per area (checkout, tools on the worker,
dependencies, services, database setup, tests, CI, secrets and data), proposes a workspace setup
(`.pidgen/pidgen.toml` and the scripts it names), and rehearses it on a worker in a throwaway
workspace. Later, the Project doctor asks whether the setup is why work in the Project fails.
Readiness never holds work back: a Ticket filed before the setup is merged runs with whatever is
merged when its workspace is built.

| Command | Does | Route |
|---|---|---|
| `pidgen project inspect <key>` | The findings, one row per area, and the open questions | `GET /projects/{project_ref}/readiness` |
| `pidgen project inspect <key> --answer <id>=<value>` | Answer questions and inspect again | `POST /projects/{project_ref}/readiness/answers` |
| `pidgen project setup <key>` | The proposed files; writes nothing | `GET /projects/{project_ref}/readiness` |
| `pidgen project setup <key> --write [--force]` | Write the proposed files under `.pidgen/` in this checkout | `GET /projects/{project_ref}/readiness/proposal/archive` |
| `pidgen project setup <key> --pull-request` | Open the pull request that proposes them | `POST /projects/{project_ref}/readiness/proposal/pull-request` |
| `pidgen project rehearse <key> [--ref <branch>] [--no-follow]` | Rehearse the setup on a worker and follow it | `POST /projects/{project_ref}/readiness/rehearse`, then `GET /projects/{project_ref}/readiness` |
| `pidgen project doctor <key> [--since <n>d] [--propose-fix] [--json]` | Ask whether the setup is why work fails; exit 1 when it is | `POST /projects/{project_ref}/readiness/doctor` |

The server has agreed these routes and not yet published them
([API compatibility](api-compatibility.md#project-readiness)). `<key>` is the project's id or
ticket-key prefix, as for `project show`; a missing, empty, `.` or `..` key is `CLI_USAGE` (exit
code 2) and sends nothing. An unknown project exits 4 with `PROJECT_NOT_FOUND`. None of them has a
preview: reading, answering a question, opening the setup pull request and rehearsing each act
directly, and nothing is written to the repository except by `--write` (in your checkout) or
`--pull-request` (as a pull request you review).

- `pidgen project inspect <key>` — `data` is the readiness unchanged: `inspection` (`state`
  `inspecting`, `inspected` or `failed`, the `ref` and `commit` read), `areas` (each with `area`,
  `title`, `state` — `ok`, `proposed`, `needs_you`, `cannot_tell` or `pending` — `summary`,
  `proposal` and `ask`), `questions` (each with `question_id`, `question`, `evidence`, `choices`,
  `default` and `answer`, null while open), `proposal` and `rehearsal`. A terminal shows one row
  per area with its state word (ok, proposed, needs you, cannot tell, pending) and summary, then
  each open question with its evidence and the `--answer` that answers it, e.g.
  `pidgen project inspect STO --answer stripe-test-key=<pass|skip>`.
- `--answer <id>=<value>` (repeatable) sends the answers and the repository is inspected again;
  `data` is the readiness the server answers, its inspection `inspecting`. A value without `=`, an
  empty id or value, or an id given twice is `CLI_USAGE` and sends nothing. An unknown question is
  the server's `READINESS_QUESTION_UNKNOWN` (exit 2).
- `pidgen project setup <key>` — `data` is the readiness's `proposal`: `state` (`draft`,
  `pull_request_open` or `merged`), `files` (each `path`, `executable` and `bytes`),
  `assumptions` and `pull_request`. No proposal yet exits 4 with `READINESS_PROPOSAL_NOT_FOUND`.
- `--write` downloads the proposed files (a gzip tar) and extracts them under `.pidgen/` at the
  root of the git checkout you run it in, from any directory inside it: scripts with mode 0755,
  everything else 0644, as the archive's executable bits say. `data` is `project_key`, `root` and
  `files`, each with `path`, `executable` and `status` (`created`, `updated` or `unchanged`).
  Everything is checked before anything is written: outside a git checkout it exits 2 with
  `NOT_A_CHECKOUT` and sends nothing; an existing `.pidgen/` that the write would change at all (a
  file created in it, replaced, or given another mode) exits 5 with `FILES_EXIST` (`details.paths`
  lists those files) unless `--force`, while writing the same proposal again changes nothing and
  exits 0; files of the checkout's own under `.pidgen/` that the proposal does not name are left
  alone; a symbolic link or a file
  where a directory goes exits 5 with `UNSAFE_PATH`; an archive that is not a gzip tar, names a
  path outside `.pidgen/` or holds a link exits 1 with `ARCHIVE_INVALID`. `--force` without
  `--write` is `CLI_USAGE`.
- `--pull-request` opens the pull request through the Project's forge connection; `data` is the
  proposal with its `pull_request` (`url`, `number`, `branch`, `state`). One already open is
  answered unchanged. A Project with no forge exits 5 with `FORGE_NOT_CONNECTED` (use `--write`);
  an unanswered question exits 5 with `READINESS_QUESTIONS_OPEN`. `--write` and `--pull-request`
  together are `CLI_USAGE`.
- `pidgen project rehearse <key>` asks a worker to build a throwaway workspace from the proposal's
  branch (or `--ref <branch>`; the base branch once the setup is merged), run `provision`,
  `activate`, the database step and the tests, and tear it down, then reads the readiness every 2
  seconds until the rehearsal settles. Each step is printed as it is reported — on a terminal's
  standard output, or on standard error under `--format json` when standard error is a terminal —
  and the verdict last. `data` is the settled rehearsal (`state`, `ref`, `commit`, `worker`,
  `steps` with `exit_code` and `duration_seconds`, `verdict`, `log_artifact_id`). A failed
  rehearsal exits 1 with `REHEARSAL_FAILED`, a cancelled one with `REHEARSAL_CANCELLED`, the
  rehearsal in `error.details.rehearsal`. One still running after 30 minutes exits 8 with
  `TIMEOUT` and goes on; `pidgen project inspect` shows it. `--no-follow` returns the queued
  rehearsal at once. Another rehearsal running exits 5 with `REHEARSAL_IN_PROGRESS`; no connected
  worker that can run the Project exits 5 with `NO_ELIGIBLE_WORKER`. An empty `--ref` is
  `CLI_USAGE`.
- `pidgen project doctor <key>` asks whether the workspace setup is why work in the Project fails.
  The doctor reads the setup files on the base branch through a worker, the connected workers and
  the last 7 days of runs (`--since <n>d` or `<n>w` widens it, 1 to 90 days; anything else is
  `CLI_USAGE` and sends nothing) and changes nothing. `data` is its report unchanged:
  `verdict` (`setup`, the setup is the problem; `code`, it is not and the failures are code; or
  `unclear`, the doctor cannot tell), `summary` (the verdict as a
  sentence with its evidence), `groups` (`setup_files`, `workers`, `secrets`, `workspaces`,
  `tests` and `drift`, each with its `title` and `checks`: `state` — `ok`, `needs_you` or
  `failed` — `summary`, `evidence`, `tickets` by key, `cause` and `fix`), `fix` (`summary`,
  `template`, `pull_request` and the Tickets to `retry`), `failed_tickets` and `rehearse` (why to
  rehearse again, or null). A terminal shows the frame of `pidgen setup`: one line per group with
  its worst check's symbol (`◇` ok, `▲` needs you, `■` failed), beneath each failure what it said
  with its Tickets by key, the change that introduced it and the fix, then the verdict line, its
  sentence and the commands to run next (`Fix:`, `Then:` or `Open:`, `Also:`). When the setup is
  the problem it exits 1 with `SETUP_IS_THE_PROBLEM`, the report in `error.details.report`; `code`
  and `unclear` exit 0, the verdict line reading "The setup is not the problem." or "The doctor
  cannot tell whether the setup is the problem.".
  `--propose-fix` has the doctor open the fix as a pull request when it has a template for it
  (`fix.pull_request`); a Project with no forge exits 5 with `FORGE_NOT_CONNECTED`. `--json`
  prints the report alone, as the server answered it, with the same exit status; an error under
  `--json` is the JSON envelope.

## domain

A domain is a named group of projects in the Account. Domains nest: each has one or more parent
domains, up to 8 levels deep, under the **Account domain**, which contains every other. **Domain
Members** read everything in the projects the domain covers; **Maintainers** manage the domain, and
a Maintainer is also a member. The routes are in the published document
([API compatibility](api-compatibility.md#domains-contracts-requests-and-worker-releases)).

| Command | Does | Route |
|---|---|---|
| `pidgen domain list` | Domains you can read, the Account domain first | `GET /domains` |
| `pidgen domain show <domain>` | One domain | `GET /domains/{domain_id}` |
| `pidgen domain create --name <name> --key <KEY> [--parent <domain>]...` | Create a domain | `POST /domains` |
| `pidgen domain edit <domain> [--name <name>] [--key <KEY>]` | Rename or rekey a domain | `PATCH /domains/{domain_id}` |
| `pidgen domain archive <domain>` | Archive a domain | `PATCH /domains/{domain_id}` `{archived: true}` |
| `pidgen domain unarchive <domain>` | Unarchive a domain | `PATCH /domains/{domain_id}` `{archived: false}` |
| `pidgen domain project add <domain> <project>` | The domain contains the project | `PUT /domains/{domain_id}/projects/{project_ref}` |
| `pidgen domain project rm <domain> <project>` | The domain stops containing the project | `DELETE /domains/{domain_id}/projects/{project_ref}` |
| `pidgen domain parent add <domain> <parent-domain>` | Put the domain under another parent | `PUT /domains/{domain_id}/parents/{parent_id}` |
| `pidgen domain parent rm <domain> <parent-domain>` | Remove one of its parents | `DELETE /domains/{domain_id}/parents/{parent_id}` |
| `pidgen domain member add <domain> <user-id>` | Make the person a Domain Member | `PUT /domains/{domain_id}/people/{user_id}` `{role: member}` |
| `pidgen domain member rm <domain> <user-id>` | Remove the person from the domain | `DELETE /domains/{domain_id}/people/{user_id}` |
| `pidgen domain maintainer add <domain> <user-id>` | Make the person a Maintainer | `PUT /domains/{domain_id}/people/{user_id}` `{role: maintainer}` |
| `pidgen domain maintainer rm <domain> <user-id>` | The person stops maintaining and stays a member | `PUT /domains/{domain_id}/people/{user_id}` `{role: member}` |
| `pidgen domain epics <domain> [--state open\|finished] [--page <n>] [--per-page <n>] [--no-subdomains]` | The domain's Epics, their work by project, and what you cannot see | `GET /domains/{domain_id}/epics` |

`<domain>` and `<parent-domain>` are a domain's key, such as `PAY`, or its id;
`<project>` is a project's id or ticket-key prefix; `<user-id>` is the person's user id (a UUID),
and they must be an active member of the Account. Each is sent percent-encoded as one path segment. Every
command sends one request with the selected profile's credential and Account; the writes act
directly, with no preview ([Preview and apply](preview-and-apply.md)). Reads need `tickets:read`,
writes `tickets:write`.

`data` is the server's domain (for `list`, the array of them) unchanged: its `id`, `key`, `name`,
`is_account_root`, `archived` and `archived_at`, the ids of its `parents` and of the `projects` and
`domains` it contains, its people counts under `people` (`members`, `maintainers`) and its Epic
counts under `epics` (`open`, `total`). `show` and every write answer the domain as it now stands,
with `granted`, the people granted directly on it (`user_id`, `role`). A request body is checked
against the published document before it is sent, and an answer that does not match it exits 1 with
`UNEXPECTED_RESPONSE`, `error.details.route` naming the route and `error.details.issues` what is
wrong.

- `pidgen domain create` — sends `{name, key}`, with `parent_ids` when `--parent` is given (repeat
  it for more parents); without it the server puts the domain under the Account domain. The key is
  3-6 uppercase letters or digits; another key is the server's `DOMAIN_KEY_INVALID` (422, exit 2).
  A key that is already a project prefix or domain key of the Account is the server's
  `DOMAIN_KEY_TAKEN` (409, exit 5).
- `pidgen domain edit` — sends only the fields given; an edit with neither `--name` nor `--key` is
  `CLI_USAGE` (exit 2) and sends nothing.
- `pidgen domain maintainer rm` keeps the person as a Domain Member; `pidgen domain member rm`
  removes them, Maintainer or not.

The server's refusals keep their codes and `error.details`:

| Code | When | Exit |
|---|---|---|
| `DOMAIN_NOT_FOUND` | No such domain in the Account (another Account's included) | 4 |
| `MEMBER_NOT_FOUND` | The person is not an active member of the Account | 4 |
| `DOMAIN_CYCLE` | The parent is already inside the domain | 5 |
| `DOMAIN_TOO_DEEP` | Nesting would pass 8 levels | 5 |
| `DOMAIN_IS_ACCOUNT_ROOT` | A parent link naming the Account domain either way, archiving it, or rekeying it once it holds an Epic | 5 |
| `DOMAIN_COVERAGE_IN_USE` | Removing a project or parent while open work under the domain's Epics sits in a project leaving its coverage; `error.details.ticket_keys` names the work you can see and `hidden_count` counts the rest | 5 |
| `DOMAIN_HAS_OPEN_EPICS` | Archiving a domain with an open Epic; `error.details.ticket_keys` names them | 5 |
| `DOMAIN_KEY_TAKEN` (409) | The key is already a project prefix or domain key of the Account | 5 |
| `DOMAIN_KEY_INVALID`, `DOMAIN_KEY_FIXED` (422) | The key is not 3-6 uppercase letters or digits, or the domain's home already holds a Ticket | 2 |
| `ENTITLEMENT_LIMIT_REACHED` or `FEATURE_NOT_IN_PLAN` (403) | The Account's domains feature is switched off; writes are refused, reads still answer | 3 |

The five graph refusals exit 5 whether the server answers them 409 or 422. A missing `<domain>`,
`<project>`, `<parent-domain>` or `<user-id>`, an empty, `.` or `..` one, an extra argument, a
`create` without `--name` or `--key`, or an empty `--name`, `--key` or `--parent`, is `CLI_USAGE`
(exit 2) and sends nothing.

### Domain Epics

A **Domain Epic** is an Epic filed in a domain rather than in one project: it holds work from
several of the domain's projects. It is a planning and tracking parent, not a workspace: it owns no
branch, and each project's work under it delivers to its own project as usual. The server files it
in the domain's home project, so its key is the domain's key and a number (`COM-12`), its
`branch_mode` is `project_base`, and it takes the Account's Unassigned Agent and the
`epic-delivery` workflow type. A Domain Epic may name a Domain Epic of an ancestor domain as its
`parent_ticket_id`.

- File one with `pidgen ticket create --kind epic --domain <domain> -f <file>` or
  `pidgen epic create --domain <domain> -f <file>` (see [ticket](#ticket)).
- Work joins a Domain Epic as it joins any Epic: name the Domain Epic as the ticket's
  `parent_ticket_id`, and a manifest may name one as its `epic_id`. Work in a project outside the
  domain's coverage is refused with the server's `PARENT_OUTSIDE_DOMAIN`. Nothing in the CLI
  changes for this.
- `pidgen domain epics <domain>` reads a domain's Epics (`GET /domains/{domain_id}/epics`).
  `--state`, `--page`, `--per-page` and
  `--no-subdomains` are sent as `state`, `page`, `per_page` and `subdomains=false`; a flag not
  given is not sent, so the route's defaults apply: open Epics, the subdomains' Epics included, 10
  finished Epics a page. `data` is the server's: `epics`, each with its `epic`, the `domain_id` it
  belongs to, its work grouped by project in `projects` (each `{project: {id, key, name},
  ticket_ids}`) and `hidden`, how many of its tickets you cannot see; `tickets`, every ticket the
  groups name; and `running`. An answer that does not match the published `DomainEpicBoard` exits 1
  with `UNEXPECTED_RESPONSE`. An unknown `--state`, a `--page` that is not a whole number from 1, a
  `--per-page` outside 1 to 50 or a missing `<domain>` is `CLI_USAGE` (exit 2) and sends nothing;
  an unknown domain is `DOMAIN_NOT_FOUND` (exit 4). Needs `tickets:read`.

## contract

A **contract** is a project's or a domain's public interface: a REST, GraphQL, gRPC, events or
library interface, or another kind. It has a provider (a project or a domain), a title, an owner
and a status (`draft`, `accepted`, `deprecated`, `retired`), and is keyed per Account as `CT-<n>`.
Each **revision** has a number, a kind, Markdown, an optional native schema and its format, a
change (`additive` or `breaking`), its operations, and how it was accepted. Every contract and every
revision is readable by everyone in the Account; work in projects you cannot open appears only as a
count. An accepted revision never changes.

A contract enters Pidgen as a file: the provider publishes its spec file with
`pidgen contract publish` (by hand, or from its CI on every merge to its default branch), and an
addition another project needs is proposed from a fragment file with `pidgen contract propose`.
The CLI moves the files; it never reads a schema into a command. A contract can also be created
with `pidgen contract create` and changed by revising it. A **published** revision describes code
that exists; each operation of a contract is **landed** (in the newest published revision),
**pending** (proposed and accepted, not yet published) or **removed** (in an earlier published
revision and not in the newest). A new contract or
revision is accepted at once, unless the Account's Contract approval setting asks for a person
(before breaking revisions, or before any); then it waits, and work linked to the contract does not
start until someone accepts it. The routes are in the published document
([API compatibility](api-compatibility.md#domains-contracts-requests-and-worker-releases)).

| Command | Does | Route |
|---|---|---|
| `pidgen contract list --project <project>` | A project's contracts, then those its work builds against | `GET /projects/{project_ref}/contracts` |
| `pidgen contract list --domain <domain>` | A domain's contracts, its coverage's by provider, then those its work builds against | `GET /domains/{domain_id}/contracts` |
| `pidgen contract show <contract>` | One contract, its revisions, each operation's state and the work linked to it | `GET /contracts/{contract_id}` |
| `pidgen contract create (--project <project> \| --domain <domain>) [-f <file>] [--title <title>] [--kind <kind>] [--schema-format <format>] [--schema <file>] [--markdown <file.md>] [--owner <user id>] [--existing]` | Create a contract a Project or a Domain provides, with its first revision | `POST /projects/{project_ref}/contracts` or `POST /domains/{domain_id}/contracts` |
| `pidgen contract publish <file> (--project <project> \| --domain <domain>) [--path <source path>] [--commit <sha>] [--ref <ref>] [--include <glob>...] [--breaking] [--check]` | Publish a spec file, with the files beside it, as the contract at its source path: created the first time, revised after | `POST /projects/{project_ref}/contracts/publish` or `POST /domains/{domain_id}/contracts/publish` |
| `pidgen contract propose <contract> <fragment> [--include <glob>...] [--check]` | Propose a revision from a fragment file | `POST /contracts/{contract_id}/proposals` |
| `pidgen contract propose --project <project> --title <title> <fragment> [--include <glob>...] [--check]` | Propose a contract the project is to provide, before it exists | `POST /projects/{project_ref}/contracts/proposals` |
| `pidgen contract revise <contract> -f <file> [--markdown <file.md>]` | Add a revision | `POST /contracts/{contract_id}/revisions` |
| `pidgen contract accept <contract> [--revision <n>]` | Accept a waiting revision | `POST /contracts/{contract_id}/revisions/{revision_number}/accept` |

`<contract>` is a contract's key, such as `CT-7`, or its id; `<project>` is a project's key prefix
or id and `<domain>` a domain's key or id. Each is sent as one percent-encoded path segment. `data`
is the server's answer unchanged, and every answer is validated against the published document:
one that does not match exits 1 with `UNEXPECTED_RESPONSE`. The writes act directly, with
no preview ([Preview and apply](preview-and-apply.md)).

- `pidgen contract list` — give exactly one of `--project` and `--domain`; both, neither or an
  empty one is `CLI_USAGE` (exit 2) and sends nothing. For a project `data` is
  `{provides, builds_against}`: its own contracts and those its work builds against from outside
  it. For a domain it is `{own, coverage, builds_against}`: the contracts the domain itself
  provides, its covered projects' contracts grouped by `provider`, and those its work builds
  against. Each entry is the contract without revisions: its `id`, `key`, `number`, `title`,
  `status`, `provider` (`project_id`, `kind` of `project` or `domain`, `domain_id` — null for a
  project's — `key` and `name`), `owner_user_id`, `kind`, `implemented`,
  `newest_accepted_revision`, `waiting_revisions` and its replacement, if deprecated.
- `pidgen contract show` — `data` is the contract with its `revisions`, oldest first, each with
  `number`, `kind`, `change`, `schema_format`, `operations` (each `{name, types?}`), `markdown`,
  `native_schema` and `acceptance`: `waiting`, `automatic`, or `person` with `accepted_by` (a user
  id) and `accepted_at`. Its `implemented_by` and `built_against_by` each list the Tickets you can
  see in `work` (`{ticket_id, ticket_key, title, stage, project_id, operations}`) and count the rest
  in `hidden_count`. `implemented` is true once the implementing work completes; `may_revise` and
  `may_accept` say what you may do. `operation_states` lists each operation by `name` with its
  `state`: `landed` (in the newest published revision, in its order), then `pending` (in an accepted
  proposed revision, not yet published), then `removed` (in an earlier published revision and not
  the newest). A state outside those three exits 1 with `UNEXPECTED_RESPONSE`.
- `pidgen contract create` — give exactly one of `--project` (the provider Project) and
  `--domain` (the provider Domain's id; the provider is the Domain's home); both, neither or an
  empty one is `CLI_USAGE` (exit 2). The body is `-f`'s file (JSON or YAML, or `-f -` for standard
  input): `{title, kind, markdown, schema_format, native_schema?, operations?, owner_user_id?,
  describes_existing?}`, each operation `{name, types?}`; there is no `change`, a first revision is
  additive. The flags override the file: `--title`, `--kind` (`rest`, `graphql`, `grpc`, `events`,
  `library`, `other`), `--schema-format` (`openapi`, `graphql`, `proto`, `asyncapi`, `typescript`,
  `python`, `prose`; named so because the global `--format` is the output format), `--markdown
  <file.md>` reads the document, `--owner <user id>` sets `owner_user_id` (by default you own it),
  and `--existing` sets `describes_existing: true`: the interface already exists in the provider's
  code, so the contract reads implemented once accepted. Files are read relative to the working
  directory. With a native schema in the file and no markdown, the CLI writes the document:
  `# <title>` and a line saying the interface is described by its `<format>` schema.
  `--schema <file>` never reads the file into `native_schema`: with `--existing` it publishes the
  file as `pidgen contract publish` does, and otherwise it proposes it, with the files beside it, as
  a new contract the project is to provide, which needs `--project` and `--title`. With
  `--schema`, `--title` and `--schema-format` (`openapi` or `asyncapi`, the file's format, sent as
  `format`) apply, and `-f`, `--kind`,
  `--markdown` and `--owner` are `CLI_USAGE` (exit 2); `data` is the publish's or the proposal's
  answer. For example,
  `pidgen contract create --project ALPHA --title "Payments API" --schema-format openapi --schema openapi.yaml --existing`.
  The body is checked against the published `ContractCreateRequest` first: one that does not parse or
  match exits 2 with `INPUT_INVALID` and `error.details.issues`; a missing or empty `--markdown`
  file is `CLI_USAGE` (exit 2). Nothing is sent then. `data` is the created contract,
  as `pidgen contract show` prints it, with revision 1: `automatic`, or `waiting` when the Account
  asks a person to accept every new contract. Creating needs a Contributor or Manager role in the
  provider Project, Maintainer of the provider Domain, or Owner or Administrator; a Domain's
  contract also needs the Account's plan to include Domains.
- `pidgen contract publish` — sends files, never schema text: `<file>` as the entry and the files
  beside it, every `.json`, `.yaml` and `.yml` file under the entry's directory (never under
  `node_modules` or a dot directory), or with `--include <glob>` (repeatable; `*`, `**`, `?`,
  `{a,b}`) only the files there that match. Each is named by its path relative to the entry's
  directory, and the server resolves relative `$ref`s among them and nowhere else. A bundle holds at
  most 200 files and 8 MiB in all: over that it exits 5 with `FILE_TOO_LARGE` and sends nothing. The
  contract is identified by its provider and its source path: `--path`, or by default the entry's
  path relative to the root of its git repository (outside a repository give `--path`; an absolute
  one, or one that leaves the repository, is `CLI_USAGE`). It sends `source_kind` `ci` when the
  environment has `CI=true`, else `upload`, and `--commit` and `--ref` when given. `--breaking`
  records the change as breaking whatever comparing the operations says. `data` is the server's
  answer: `outcome` (`created`, `revised` or `unchanged` — the same interface again records
  nothing), `dry_run`, `contract_id` and `contract_key` (null for a dry run of a path never
  published), `revision`, `acceptance` (`automatic` or `waiting`; null for a dry run or
  `unchanged`), `change` (`additive` or `breaking`; null when unchanged) and `change_reason`, the
  file's `format`, `version`, `title` and `source_path`, its `operation_count` and `type_count`,
  the operations `added` and `removed`, the types `types_added` and `types_removed`, the pending
  operations it `landed` and those `still_pending`, and the earlier refused publishes of the path it
  resolves (`resolved_refusals`).
  `--check` is the dry run for pull requests: it records nothing, exits 0 when the change is
  additive or the file is unchanged, and on a breaking change exits 5 with
  `CONTRACT_CHANGE_BREAKING` (the `change_reason`, or else the removed operations, in `error.message`, the dry run's answer in
  `error.details.result`) unless `--breaking` is given. A provider's pipeline needs two lines:
  `pidgen contract publish contracts/public-api/openapi.json --project ALPHA --commit "$GITHUB_SHA" --ref "$GITHUB_REF"`
  on the default branch, and the same with `--check` on pull requests.
- `pidgen contract propose` — sends a fragment file in the contract's format holding only the
  operations being added or changed, with the files beside it as `publish` sends them (every
  `.json`, `.yaml` and `.yml` file under the fragment's directory, or with `--include <glob>` only
  those matching, at most 200 files and 8 MiB in all), so its relative `$ref`s resolve; the server
  takes the operations from the fragment. `<contract>
  <fragment>` proposes a revision of an existing contract; `--project <project> --title <title>
  <fragment>` proposes a contract that does not exist yet. The proposal is accepted under the
  Account's Contract approval, and its operations stay pending until a published revision contains
  them. `--check` records nothing. `data` is `dry_run`, `contract_id` and `contract_key` (null for
  a dry run of a contract that does not exist yet), `revision`, `acceptance`, the fragment's
  `format`, `version` and `title`, its `operations`, those it made `pending` and those already
  `landed`. `--project` with a contract, without
  `--title`, or `--title` without `--project` is `CLI_USAGE` (exit 2) and sends nothing.
- A refused file, from `publish` or `propose`, exits 5 with the refusal's code and prints every error
  with its location: `error.message` names the reason and lists each error as
  `<location>: <message>` (`(no location)` when the server gives none), and `error.details.errors`
  holds them as `{message, location}`, the server's own message in `error.details.server_message`.
  A publish refused when it is not a dry run is announced in the Inbox with the refused file, and
  names it in `error.details.refusal_id`.
- `pidgen contract revise` — the file (JSON or YAML, or `-f -` for standard input) is the revision:
  `{kind, markdown, schema_format, change, operations?, native_schema?}`, each operation
  `{name, types?}`. `--markdown` reads a Markdown file, relative to the working directory, into
  `markdown`. The body is checked against the published `ContractRevisionRequest` first: one that does not parse or match exits 2 with
  `INPUT_INVALID` and `error.details.issues`; a missing or empty `--markdown` file, or a file that
  names `markdown` as well as `--markdown`, is `CLI_USAGE` (exit 2). Nothing is sent then. `data` is
  the contract with its new revision last; the revision's `acceptance` is `automatic`, or `waiting`
  when a person must accept it.
  Revising needs a Project role in the provider project, or Maintainer of the provider domain.
- `pidgen contract accept` — with `--revision <n>` accepts that revision; without it reads the
  contract and accepts its one waiting revision. With none waiting it exits 5 with
  `NO_REVISION_WAITING` (`error.details`: `contract` and each revision's `number` and `acceptance`
  in `statuses`), and with more than one waiting `REVISIONS_WAITING` (`error.details.waiting`); no
  accept is sent then. With automatic acceptance nothing ever waits. `data` is the contract with
  the accepted revision. Accepting is allowed to the provider project's Project Managers, the provider domain's
  Maintainers, the owner, and the Account's Owners and Administrators; the server decides. A
  `--revision` that is not a whole number from 1 is `CLI_USAGE` (exit 2) and sends nothing.

The server's refusals keep their codes and `error.details`:

| Code | When | Exit |
|---|---|---|
| `PROJECT_NOT_FOUND`, `DOMAIN_NOT_FOUND` | No such project or domain in the Account | 4 |
| `CONTRACT_NOT_FOUND`, `CONTRACT_REVISION_NOT_FOUND` | No such contract in the Account, or no such revision of it | 4 |
| `CONTRACT_REVISION_NOT_WAITING`, `CONTRACT_REVISION_SUPERSEDED` (409) | The named revision is already accepted, or a newer one is | 5 |
| `CONTRACT_RETIRED` (409) | The contract is retired and changes no more | 5 |
| `CONTRACT_TITLE_INVALID`, `INPUT_INVALID` (422) | The server refuses the new contract's title or body | 2 |
| `CONTRACT_FILE_INVALID` | The file does not parse or fails validation | 5 |
| `CONTRACT_FORMAT_UNSUPPORTED` | The file is not OpenAPI (2.0, 3.0, 3.1) or AsyncAPI (2.x, 3.x) | 5 |
| `CONTRACT_EXTERNAL_REF` | A `$ref` is a URL, an absolute path, or a path outside the files sent | 5 |
| `CONTRACT_CONVERSION_TIMEOUT` | Converting the files took longer than 60 seconds | 5 |
| `FILE_TOO_LARGE` | The files are over 8 MiB or 200 files in all | 5 |
| `CONTRACT_CHANGE_BREAKING` (the CLI's) | `publish --check` found a breaking change and `--breaking` was not given | 5 |
| `FORBIDDEN` (403) | You may not create a contract for the provider, revise the contract, or accept its revision | 3 |
| `ENTITLEMENT_LIMIT_REACHED` or `FEATURE_NOT_IN_PLAN` (403) | A domain's contract, and the Account's domains feature is switched off; a project's contract needs no feature | 3 |

## ticket

| Command | Does | Route |
|---|---|---|
| `pidgen ticket list [--stage] [--project] [--query] [--intervention] [--kind]` | List tickets, every page; `--kind epic` lists Epics; `--epic` is *planned* | `GET /tickets` |
| `pidgen ticket show <ref> [--kind]` | One ticket with delivery, findings and prerequisites | `GET /tickets/{ref}`, `GET /tickets/{ref}/prerequisites` |
| `pidgen ticket create -f <file> [--kind] [--domain]` | Create a structured ticket; `--kind epic` files an Epic, `--domain` a Domain Epic | `POST /tickets` |
| `pidgen ticket edit <ref> -f <file> [--kind]` | Edit content (uses the ticket's current version) | `GET /tickets/{ref}`, `PATCH /tickets/{ref}` |
| `pidgen ticket owner <ref> (--user <user_id> \| --clear) [--reason <text>]` | Set or clear the owner using the current version; requires a server publishing the owner route | `PUT /tickets/{ref}/owner` |
| `pidgen ticket follow <ref>` | Explicitly follow a ticket; requires a server publishing the following route | `PUT /tickets/{ref}/following` |
| `pidgen ticket unfollow <ref>` | Stop explicitly following a ticket; requires a server publishing the following route | `PUT /tickets/{ref}/following` |
| `pidgen ticket cancel <ref> [--disposition] [--superseded-by] [--discard-workspace] [--close-pr]` | Preview/apply cancelling a ticket and its descendants; an open pull request is left open unless `--close-pr` | `POST /tickets/{ref}/cancellation/preview`, `POST /tickets/{ref}/cancellation` |
| `pidgen ticket actions <ref> [--family <f>] [--run <id>] [--node <id>] [--prerequisite <id>] [--decision <decision_key>]` | The actions the ticket, its runs, its dependencies and its decisions allow, why a blocked one is blocked, which one is recommended, and what each would do | `GET /tickets/{ref}/actions` |
| `pidgen ticket act <ref> <action> [--run <id>] [--node <id>] [--prerequisite <id>] [--criterion <index>] [--decision <decision_key>] [--until <date-time>] [--delegate-to <user_id>] [--exception-reason <text>] [--criterion-status <status> --override-reason <text>] [--answer <decision>=<text>] [--alternative <decision>=<option>] [--reason <text>] [--note <text>]` | Preview/apply one of those actions | `GET /tickets/{ref}/actions`, `POST /tickets/{ref}/actions/preview`, `POST /tickets/{ref}/actions/execute` |
| `pidgen ticket retry <ref> [--run <id>]` | Preview/apply a fresh attempt of a failed or stalled run (`retry_run`, or `restart_refinement` for a Refinery run) | `GET /tickets/{ref}/actions?family=recovery`, `POST /tickets/{ref}/actions/preview`, `POST /tickets/{ref}/actions/execute` |
| `pidgen ticket replay <ref> --node <id> [--run <id>]` | Preview/apply a replay from one node (`replay_from_node`) | same |
| `pidgen ticket reopen <ref>` | Preview/apply reopening a completed ticket whose delivery cannot be proven | `POST /tickets/{ref}/reopen/preview`, `POST /tickets/{ref}/reopen` |
| `pidgen ticket clarify <ref> -f <answers>` | Answer a parked clarification; `abandoned` is deprecated and now places a hold | `GET /tickets/{ref}/clarification`, `POST /tickets/{ref}/clarification` |
| `pidgen ticket instructions <ref> [--kind steer\|request_changes]` | List a ticket's instructions, across its sessions | `GET /tickets/{ref}/instructions` |
| `pidgen ticket history <ref> [--show everything\|people\|observations] [--after <n>] [--limit <n>] [--all]` | Read what happened to a ticket, oldest first; `--all` follows every page | `GET /tickets/{ref}/history` |
| `pidgen ticket dep add <ref> --on <ref> [--type blocks]` | Make a ticket wait for another | `POST /tickets/{ref}/dependencies` |
| `pidgen ticket dep rm <ref> --on <ref> [--type blocks]` | Remove that edge | `DELETE /tickets/{ref}/dependencies/{source}` |
| `pidgen ticket dep list <ref>` | Edges in both directions | `GET /tickets/{ref}/dependencies` |
| `pidgen ticket contract implements <ref> <contract> [--operation <op>]...` | Link a delivery root to the contract it implements | `POST /tickets/{ticket_id}/contracts` |
| `pidgen ticket contract builds-against <ref> <contract> [--operation <op>]...` | Link work to a contract it builds against | `POST /tickets/{ticket_id}/contracts` |
| `pidgen ticket contract rm <ref> <contract>` | Remove a ticket's link to a contract | `DELETE /tickets/{ticket_id}/contracts/{contract_id}` |
| `pidgen ticket move <ref> --epic <key>\|--no-epic` | Move a ticket into or out of an Epic by its `parent_ticket_id` | `GET /tickets/{ref}`, `PATCH /tickets/{ref}` |
| `pidgen ticket template [-o <file>] [--force]` | Write an annotated ticket file to fill in | — |
| `pidgen ticket types` | The workflow types registered in the Account: the valid values of a ticket's `workflow_type`, each with its label, workflow and ticket count | `GET /workflow-types` |

`pidgen ticket list`, `pidgen ticket show` and `pidgen ticket types` are read commands like
`pidgen project list`. `pidgen ticket create`, `pidgen ticket edit`, `pidgen ticket template`,
`pidgen ticket dep add`, `pidgen ticket dep rm`, `pidgen ticket dep list`,
`pidgen ticket contract implements`, `pidgen ticket contract builds-against`,
`pidgen ticket contract rm`, `pidgen ticket move`,
`pidgen ticket cancel`, `pidgen ticket actions`, `pidgen ticket act`, `pidgen ticket retry`,
`pidgen ticket replay`, `pidgen ticket reopen`, `pidgen ticket clarify`, `pidgen ticket instructions` and
`pidgen ticket history` change or read one ticket.

- `pidgen ticket list` — `data` is one array of every ticket you can see, newest first. The CLI asks
  for pages of 100 (`page`, `per_page`) and follows them until a page holds fewer than 100, so the
  array is the whole list; a refusal on any page fails the command rather than returning part of it,
  and `meta` is the first page's. Each filter is sent as the route's query parameter and may be
  combined:

  | Flag | Query parameter | Keeps |
  |---|---|---|
  | `--stage <stage>` | `stage` | Tickets in that stage: `backlog`, `research_needed`, `specification`, `planning`, `implementation_ready`, `in_execution`, `awaiting_review`, `delivered`, `completed`, `failed`, `abandoned` |
  | `--project <id>` | `project_id` | Tickets of that project |
  | `--query <text>` | `q` | Tickets whose key, id, title or objective contains the text, ignoring case; the server returns at most 20 |
  | `--intervention <type>` | `intervention` | Tickets waiting on an open intervention of that type: `clarification_needed`, `review_required`, `execution_failed`, `child_blocked`, `delivery_blocked`, `delivery_closed_unmerged`, `delivery_auto_merge_failed` |
  | `--kind <kind>` | `kind` | Tickets of that kind: `epic`, `story` or `task`. Without `--kind` the server leaves Epics out and lists Stories and Tasks; `--kind epic` lists only Epics |

  An unknown stage, intervention type or kind, an empty `--project` or `--query`, a `--query`
  longer than 200 characters, or an argument is `CLI_USAGE` (exit code 2) and sends nothing.
  `--epic` (the members of one Epic) is *planned* and refused as `CLI_USAGE`; read an Epic's
  members with `pidgen epic dag show`.
- `pidgen ticket show <ref>` — `<ref>` is the ticket's key (e.g. `PIDGEN-12`) or id. `data` is the
  server's ticket, with its delivery, effective merge policy and open findings, plus
  `prerequisites`: whether the ticket is `ready` to run, its `readiness_blockers` and `blockers`
  explained, and its `blocking_prerequisites` (the unfinished tickets holding it, each by
  `ticket_key` and `stage`). When the server sends them, `data` also carries the ticket's
  `outcome_pause` (`state` `pausing` or `paused`, `requested_by`, `requested_at`, or `null`) and
  its `cancellation` (`cancellation_id`, `disposition`, `superseded_by`, `reason`, `requested_by`,
  `requested_at`, `state`, `pull_request_close` and what it is `awaiting`: `execution_stop`,
  `pull_request_close`, or `null`), printed as the server sends them. `meta` is the ticket's
  response. An unknown ticket, or another
  Account's, exits 4 with the server's `TICKET_NOT_FOUND`, and the prerequisites are not requested.
  `--kind <kind>` (e.g. `--kind epic`) refuses a ticket of another kind with `TICKET_KIND_MISMATCH`
  (exit code 4, with the `ticket`, its `kind` and the `expected_kind` in `error.details`), and the
  prerequisites are not requested. A missing, empty, `.` or `..` ref, or more than one, or an
  unknown `--kind`, is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen ticket create -f <file>` — creates a ticket in Backlog from a JSON or YAML file (`-f -`
  reads standard input; see [Input files](#input-files)). The body is checked against the create
  request schema and sent as written: `title` and `objective` are required, `project_id` names the
  project by id or ticket-key prefix, and `workflow_type` is one of `pidgen ticket types`.
  Optional `team_member_id` selects an Account Agent by ID (not a model name), a non-empty
  string of at most 80 characters. Omission or `null` lets the server choose the Project
  default, else the Account's reserved Unassigned Agent. The CLI sends the selection unchanged
  and keeps an omitted field omitted. The Agent is chosen when the ticket is created; an edit
  naming `team_member_id` reassigns it later (`pidgen ticket edit`). `data` is the server's created ticket, with its `id`, `ticket_key`, `stage` and, when the file asked for
  `start_refinement`, the `refinement_command_id` or the `command_error` saying why refinement did
  not start. A body that does not parse or match the schema exits 2 with `INPUT_INVALID` and
  sends nothing. The server's refusals keep their codes: `PROJECT_NOT_FOUND`, `EPIC_NOT_FOUND` and
  `TEAM_MEMBER_NOT_FOUND` exit 4; `PROJECT_REQUIRED`, `UNKNOWN_WORKFLOW_TYPE` and
  `EPIC_PROJECT_MISMATCH` exit 2; `FORBIDDEN` exits 3. No `-f`, or an argument, is `CLI_USAGE`
  (exit code 2).

  A Story or Task is filed in an Epic by naming the Epic (its key or id) as `parent_ticket_id`.
  `--kind <kind>` sets the body's `kind`; `--kind epic` files an Epic, a ticket of kind `epic`
  that holds Stories and Tasks and does no work of its own. An Epic is numbered like any ticket
  and may carry `description` (stored as its objective), `branch_mode` (`project_base`,
  `create_new` or `target`), `feature_branch`, `target_date` and `merge_policy`; it refuses
  `team_member_id`, `workflow_type`, `approval_mode`, `acceptance_criteria`, `start_refinement`,
  `required_capabilities`, `estimated_complexity` and `parent_ticket_id` (`EPIC_FIELD_REFUSED`,
  `EPIC_HAS_NO_PARENT`, exit 2). A file whose `kind` differs from `--kind` exits 2 with
  `INPUT_INVALID` and sends nothing. An Epic's branch is checked on the project's forge
  (`EPIC_BRANCH_REFUSED`, exit 2; nothing is created).

  ```yaml
  title: Sign-in
  description: Everything people need to sign in.
  project_id: EXAMPLE
  branch_mode: create_new
  merge_policy: manual
  ```

  `--domain <domain>` (a domain's key or id) files a [Domain Epic](#domain-epics): the body is sent
  with `kind: epic` and `domain_id` set to the domain instead of `project_id`, and is checked
  against the published create request, which carries `domain_id`. Without `--domain` nothing
  changes. With it, `--kind story`
  or `--kind task`, or a file naming `project_id`, `branch_mode` or `feature_branch` (even as
  `null`), another `kind` or another `domain_id`, exits 2 with `INPUT_INVALID`, `error.details.issues`
  naming each field (`$.project_id`, …), and sends nothing; an empty `--domain` is `CLI_USAGE`.
  The server's refusals keep their codes: `DOMAIN_HAS_NO_PROJECTS` (the domain contains no
  project) exits 5; `DOMAIN_PROJECT_CONFLICT` and `EPIC_FIELD_REFUSED` exit 2; `DOMAIN_NOT_FOUND`
  exits 4; a 403 (you may not create a Domain Epic — Domain Maintainers, Owners and Administrators
  may — or the Account's domains feature is switched off) exits 3.

  ```yaml
  title: Checkout across payments and cards
  description: One checkout across the payment and card projects.
  target_date: 2026-12-01T00:00:00Z
  ```
- `pidgen ticket edit <ref> -f <file>` — changes a ticket's content. The file holds only the fields
  to change (`title`, `objective`, `scope_boundaries`, `assumptions`, `open_questions`,
  `acceptance_criteria`, `success_metrics`, `context_artifacts`, `required_capabilities`,
  `priority`, `estimated_complexity`, `merge_policy`, `team_member_id`, `parent_ticket_id`,
  `add_artifact_upload_ids`, `remove_artifact_ids`); a list replaces the ticket's list, and
  `merge_policy: null` makes the ticket inherit again. `parent_ticket_id` moves the ticket into an
  Epic, or out of it with `null` (as `pidgen ticket move` does). `--kind <kind>` (e.g.
  `--kind epic`) refuses a ticket of another kind with `TICKET_KIND_MISMATCH` (exit code 4) after
  the read, and no edit is sent.
  `success_metrics`, `context_artifacts` and `required_capabilities` accept arrays or null as
  whole-list replacements, with the same item shapes as creation. Metrics require `name` and
  `target` (optional `current`, `unit`); artifacts require `type` and `content` (optional
  `reference_url`, `tier`); capabilities are strings. Omitted fields stay unchanged. These edits
  let a hand-refined Backlog ticket add readiness content before promotion.
  `title` renames the ticket: it must not be empty once its surrounding spaces are trimmed,
  and it is sent as written. A file naming only `title` is a complete edit. The CLI reads the ticket
  (`GET /tickets/{ref}`) and sends its current `version` with the fields, so the file never names
  `version`. A file that does not parse or match the edit schema, names no field, names
  `version`, or has a blank `title` exits 2 with `INPUT_INVALID` and sends nothing. `data` is the
  ticket as the edit left it, plus `admission`: the server's report of what the edit did to the
  root's execution admission and planning (`root_ticket_id`, `admission_invalidated`,
  `root_stage`, `plan_revised`, `review_required` and `planning_restarted`), which the server sends
  when the edit withdrew admission or restarted planning, and `null` when it was untouched.
  `meta` is the edit's response. A ticket that
  changed between the read and the edit is the server's `CONFLICT` (exit code 5, with
  `expected_version` and `actual_version` in `error.details`): read it again and retry. A field
  the ticket's stage does not allow editing (`EDIT_STAGE_NOT_ALLOWED`), a merge policy that can no
  longer change because the pull request is merged (`EDIT_MERGE_POLICY_LOCKED`) and work execution
  already owns (`EDIT_EXECUTION_ALREADY_ACCEPTED`, `EDIT_CAPACITY_LEASE_ACTIVE`) also exit 5. The
  first two name what was refused in `error.details`: `details.field` is the refused field and,
  for `EDIT_STAGE_NOT_ALLOWED`, `details.stage` is the ticket's stage. Which stages accept which
  field is the server's rule; the CLI does not check it and reports the refusal as the server
  gives it. An unknown ticket
  exits 4 with `TICKET_NOT_FOUND` and nothing is changed. A missing, empty, `.` or `..` ref, more
  than one, or no `-f` is `CLI_USAGE` (exit code 2).
  `team_member_id` reassigns the ticket to that Account Agent (an Agent ID of 1 to 80 characters,
  not a model name) through the server's assignment, which also accepts an Agent-only edit in any
  stage the assignment allows; it is sent as written. `null`, an empty ID or one over 80
  characters exits 2 with `INPUT_INVALID` and sends nothing; to unassign, name the Account's
  reserved Unassigned Agent. Eligibility is the server's: `TEAM_MEMBER_NOT_FOUND` exits 4,
  `TEAM_MEMBER_ARCHIVED` (422) exits 2 and an assignment refusal (409) exits 5, each with the
  server's code. Conflicts cause no automatic write retry or admin fallback.
- `pidgen ticket owner <ref> --user <user_id>` or `pidgen ticket owner <ref> --clear`, with optional
  `--reason <text>` — reads the ticket's current `version` and sends it with `owner_user_id`
  (the user id or `null` to clear) and the reason when given. `data` is the server's result:
  `ticket_id`, `owner_user_id`, `effective_owner` (`user_id`, `display_name`, and `source`:
  `ticket`, `parent`, `submitter` or `none`), and the resulting `version`. A stale version (409)
  and `OWNER_NOT_ELIGIBLE` (422) exit 5; permission denied (403) exits 3. Give exactly one of
  `--user` and `--clear`: neither, both, or an empty user id exits 2 with `CLI_USAGE` before any
  request. This command requires a server publishing the owner route; an
  unavailable route reports the server's 404 (exit 4).
- `pidgen ticket follow <ref>` and `pidgen ticket unfollow <ref>` — send `following: true` or
  `following: false` respectively. The operation is idempotent. `data` is the server's result:
  `ticket_id`, effective `following`, and `source` (`explicit`, `owner`, `administrator` or
  `null`). Removing explicit following can leave effective following through ownership or
  administration; the CLI prints what the server reports. An unreadable ticket or unavailable
  route reports the server's 404 (exit 4). They require a server publishing the following route.
  These commands and `ticket owner` act immediately:
  their public routes provide no preview operation. A missing, empty, `.` or `..` ref, an extra
  argument or an unknown flag exits 2 with `CLI_USAGE` and sends nothing.
- `pidgen ticket template [-o <file>] [--force]` — writes an annotated YAML ticket to fill in, to
  `ticket.yaml` in the working directory unless `-o` names another file. Every value in it is valid
  as written, so `pidgen ticket create -f` accepts the file unchanged; comments say what each field
  means and which to replace. Its acceptance criterion has a `statement` (the only required
  field), a `priority` and an optional `assertion` — what a verifier would see when the criterion
  holds; `test_assertion` appears only in a comment, as an advanced pinned check for when one
  specific command must run. It also writes `estimated_complexity` (3), `context_artifacts` (an
  empty list, with a commented example) and `required_capabilities` (an empty list). Each scored
  field is annotated with the readiness points it earns: a ticket runs only with 60 of 100 points
  and an `estimated_complexity`. Criteria earn 10 points each (at most 30) and MUST criteria 5
  more each (at most 20); `scope_boundaries` and `success_metrics` earn 10 each; context artifacts
  earn 5 each (at most 15); each open question costs 5; `estimated_complexity` and
  `required_capabilities` earn none; and reaching `implementation_ready` adds 15. It calls no
  route. `data` is `{path, format}`, the absolute path
  written and `yaml`. An existing file is kept and the command exits 2 with `CLI_USAGE` unless
  `--force` is given; an empty `-o` or an argument is also `CLI_USAGE`. A file that cannot be
  written exits 1 with `CLI_INTERNAL`.
- `pidgen ticket types` — `data` is the server's array of workflow types, ordered by `key`, each with
  `key` (the value a ticket's `workflow_type` names), `label`, `workflow_name` (the workflow it
  runs), `ticket_count` (tickets of that type you can see), `builtin`, `default` and `version`. It
  takes no arguments; an extra one is `CLI_USAGE` (exit code 2).
- `pidgen ticket dep add <ref> --on <ref> [--type <type>]` — declares that the `<ref>` ticket
  depends on (waits for) the `--on` ticket, each named by its key (e.g. `PIDGEN-2`) or id. It sends
  `--on` as `source_id`, and `--type` (`blocks`, `informs` or `parallel_safe`) as `dep_type` when
  given; the server's default is `blocks`. Both tickets must be in the same project. `data` is the
  stored edge (`id`, `source_id`, `target_id`, `dep_type`, `project_id`, and a retired `epic_id`
  that is always `null`: an edge carries no Epic label). Either ticket may be an Epic. Adding an
  edge that already exists returns it. The server's refusals keep their codes and exit 5: a cycle (`DEPENDENCY_CYCLE`, with the
  cycle in `error.details`), `DEPENDENCY_SELF_EDGE`, `DEPENDENCY_CROSS_PROJECT`,
  `DEPENDENCY_TARGET_FROZEN` (`<ref>` is at or past execution), `DEPENDENCY_CROSSES_COHORT` and
  `DEPENDENCY_INCOMPATIBLE_BASE`. `TICKET_NOT_FOUND` and `DEPENDENCY_ENDPOINT_NOT_FOUND` (no such
  `--on` ticket) exit 4. No `--on` or an empty one, an unknown `--type`, or a missing, empty, `.` or
  `..` ref, or more than one, is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen ticket dep rm <ref> --on <ref> [--type <type>]` — removes the edge by which `<ref>`
  depends on `--on`: `--on` is the last path segment, and `--type` is sent as the `dep_type` query
  parameter when given (the server's default is `blocks`). `data` is the edge removed.
  `TICKET_NOT_FOUND`, `DEPENDENCY_ENDPOINT_NOT_FOUND` and `DEPENDENCY_NOT_FOUND` (no such edge)
  exit 4; `DEPENDENCY_SELF_EDGE` and `DEPENDENCY_TARGET_FROZEN` exit 5. Its usage errors are those
  of `dep add`, and a `.` or `..` `--on` is `CLI_USAGE` too.
- `pidgen ticket dep list <ref>` — `data` is the server's answer unchanged: the ticket's `ticket_id`
  and `ticket_key`; `blocked_by`, the tickets it waits for; `blocks`, the tickets waiting for it,
  each with its `id`, `ticket_key`, `title`, `stage`, `dep_type` and `edge_id`, oldest first; and
  `inherited_blocked_by`, the `blocks` edges declared on its ancestors, which hold it just as hard,
  each also naming the ancestor it is declared on (`declared_on_id`, `declared_on_key`,
  `declared_on_title`). An unknown ticket exits 4 with `TICKET_NOT_FOUND`. A missing, empty, `.`
  or `..` ref, or more than one, is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen ticket move <ref> --epic <key>|--no-epic` — moves a ticket into the Epic `--epic` names
  (its key such as `PIDGEN-40`, or its id), or out of its Epic with `--no-epic`, by setting the
  ticket's `parent_ticket_id`: the CLI reads the ticket (`GET /tickets/{ref}`) for its `version` and
  sends `PATCH /tickets/{ref}` with `version` and `parent_ticket_id` (the Epic, or `null`). The Epic
  must be in the ticket's own project, and only a ticket without a parent or a member of an Epic
  moves, before its execution starts. `data` is the ticket as the move left it, with `admission`
  (as `pidgen ticket edit` reports it) and `move`: `moved` (false when the ticket was already
  there), `previous_parent_ticket_id` and `parent_ticket_id`. `TICKET_NOT_FOUND` exits 4,
  `FORBIDDEN` exits 3, `CONFLICT` (the ticket changed between the read and the move) exits 5, and
  `PARENT_PROJECT_MISMATCH` (an Epic of another project), `PARENT_NOT_EPIC`, `EPIC_HAS_NO_PARENT`
  and `PARENT_CHANGE_NOT_DELIVERY_ROOT` exit 2. Exactly one of `--epic` and `--no-epic` is
  required: both, neither, an empty `--epic`, or a missing, empty, `.` or `..` ref, or more than
  one, is `CLI_USAGE` (exit code 2) and sends nothing.

### ticket contract

Work links to a [contract](#contract), never to other work. Only a **delivery root** links: in the
contract's provider project (or, for a domain's contract, a project the domain covers) it
**implements** the contract and gains the acceptance criterion "implements {contract}"; in any other
project a delivery root or an Epic **builds against** it. A link names the operations it uses; none
named means all of them. **A link never blocks**: it is not a dependency edge (use
[`ticket dep add`](#ticket) for that), and linked work waits only while the contract has a revision
waiting for a person, when the Account's Contract approval setting asks for one. The server
attaches the contract's accepted revision to the linked ticket's runs itself; the CLI uploads
nothing. The routes are in the published document
([API compatibility](api-compatibility.md#domains-contracts-requests-and-worker-releases)).

| Command | Route | Body |
|---|---|---|
| `pidgen ticket contract implements <ref> <contract> [--operation <op>]...` | `POST /tickets/{ticket_id}/contracts` | `{contract_id, link: "implements", operations}` |
| `pidgen ticket contract builds-against <ref> <contract> [--operation <op>]...` | `POST /tickets/{ticket_id}/contracts` | `{contract_id, link: "builds_against", operations}` |
| `pidgen ticket contract rm <ref> <contract>` | `DELETE /tickets/{ticket_id}/contracts/{contract_id}` | — |

`<ref>` is the ticket's key or id and `<contract>` the contract's key, such as `CT-7`, or its id;
both are percent-encoded path segments where they appear in the route. `--operation` is repeatable,
each an operation the contract's newest accepted revision names, e.g. `--operation 'GET /payments'`;
with none, `operations` is `[]`. `data` is the ticket's contracts after the change, validated
against the published document (`UNEXPECTED_RESPONSE`, exit 1, when it does not match):
`contracts`, each link's `contract_id`, `key`, `title`, `status`, `provider_project_id`, `link`,
`operations`, `criterion_id` (the criterion an implements link adds; `null` for builds-against),
`linked_at` and `linked_by`. `rm` removes whichever link the ticket has to the contract and prints
the ticket's remaining contracts. The writes act directly, with no preview. A missing ticket or contract, an
empty, `.` or `..` ref, an empty contract or an empty `--operation` is `CLI_USAGE` (exit 2) and
sends nothing.

The server's refusals write nothing and keep their codes, messages and `error.details`:

| Code | When | Exit |
|---|---|---|
| `CONTRACT_LINK_NOT_DELIVERY_ROOT` | The ticket is not a delivery root | 5 |
| `CONTRACT_LINK_OUTSIDE_PROVIDER` | Implementing from outside the provider (or the domain's coverage) | 5 |
| `CONTRACT_LINK_OWN_PROVIDER` | Building against your own project's contract | 5 |
| `CONTRACT_LINK_INSIDE_COHORT` | The ticket is inside another cohort: link the cohort's root | 5 |
| `CONTRACT_DEPRECATED` | The contract is deprecated; `error.details` names its replacement | 5 |
| `CONTRACT_RETIRED` | The contract is retired | 5 |
| `CONTRACT_UNKNOWN_OPERATION` | An operation the newest accepted revision lacks; with none accepted only no `--operation` is allowed | 5 |
| `TICKET_NOT_FOUND`, `CONTRACT_NOT_FOUND`, `CONTRACT_LINK_NOT_FOUND` | No such ticket, contract, or link to remove | 4 |
| `FORBIDDEN` (403) | You may not change the ticket's links | 3 |

The seven link refusals exit 5 whatever status the server answers them with.

### ticket actions and act

```console
$ pidgen ticket actions PIDGEN-4 [--family recovery|run_control|ticket_control|decision_followup|decision_answers] [--run <id>] [--node <id>] [--prerequisite <id>] [--decision <decision_key>]
$ pidgen ticket act PIDGEN-4 retry_run [--run <id>] [--node <id>] [--fan-out-key <key>]
$ pidgen ticket act PIDGEN-4 retry_run --apply --acknowledge ambiguous_effects [--reason "…"] [--note "…"] [--no-wait]
$ pidgen ticket act PIDGEN-4 remove_dependency --prerequisite TKT-EXAMPLE [--apply]
$ pidgen ticket act PIDGEN-4 defer_decision --decision <decision_key> --until 2026-10-12T09:00:00Z [--apply]
$ pidgen ticket act PIDGEN-4 delegate_decision --decision <decision_key> --delegate-to <user_id> [--apply]
$ pidgen ticket act PIDGEN-4 hold_decision --decision <decision_key> --reason "…" [--apply]
$ pidgen ticket act PIDGEN-4 plan_work|start_work|ask_before_starting|approve_delivery [--apply]
$ pidgen ticket act PIDGEN-4 approve_with_exception --exception-reason "…" [--apply]
$ pidgen ticket act PIDGEN-4 request_delivery_changes --note "…" [--apply]
$ pidgen ticket act PIDGEN-4 override_acceptance_criterion --criterion <index> --criterion-status passing|failing|pending --override-reason "…" [--apply]
$ pidgen ticket act PIDGEN-4 correct_plan_decision --answer <decision>=<text> --alternative <decision>=<option> [--apply]
```

The App Service publishes one interface for what a ticket, its runs, its declared dependencies and
the decisions waiting on a person can do next. Each **action decision** names an `action` — any
kind the public API document's `ActionKind` lists. The CLI reads the kinds and the families from the
document it bundles, not from a list of its own, so `pidgen ticket act` accepts every one the
document publishes: `restart_refinement`, `replay_from_node`, `retry_run`,
`replace_with_current_contract`, `recover_parked_node`, `redrive_run`, `reopen_for_delivery`,
`resolve_target_conflict`, `pause_run`, `resume_run`, `cancel_ticket`, `terminate_run`,
`remove_dependency`, `retry_admission`, the six decision follow-up kinds `snooze_reminders`,
`defer_decision`, `hold_decision`, `delegate_decision`, `proceed_on_assumption` and `keep_holding`
(see [Decision follow-up](#decision-follow-up)), and the eight plan, start, approve and override
kinds `plan_work`, `start_work`, `ask_before_starting`, `correct_plan_decision`,
`approve_delivery`, `approve_with_exception`, `request_delivery_changes` and
`override_acceptance_criterion` (see [Plan, start, approve and override](#plan-start-approve-and-override)).
The server may offer further kinds, such as `relocate_run`, `wait_for_worker`, `retry_provisioning`,
`start_from_remote_branch`, `start_step_fresh`, `reapply_delivery`, `return_to_planning`,
`close_completed`, `answer_request` and `sync_comments`: `pidgen ticket actions` lists whatever the
server offers and `pidgen ticket act` sends any of them. A decision also names its `family` (`recovery`, `run_control`, `ticket_control` for
`remove_dependency`, `decision_followup`, or `decision_answers` for the plan, start, approve and
override kinds), a person-facing `label`, its `target` (`kind` `ticket`, `run`, `node`,
`dependency`, `decision` or `criterion`, with `ticket_id` and, when they apply, `run_id`,
`node_id`, `fan_out_key`, for a dependency `prerequisite_id`, for a decision `decision_key` and, for
a criterion, `criterion_index`, its position in the ticket's acceptance criteria counting from 0: a
target may omit those it does not have), two gates, `admissible`
(the ticket's state allows it) and `authorized` (you may take it), each `{allowed, refusal}` with
the refusal's `code`, `message` and the action to take `instead`; `recommended` (`{reason}` on the
recommended action, else null); its `consequence` (`run`: `continue` or `fresh`, and for each input
`class` — `configuration`, `contract`, `ticket_instructions`, `rework_brief` — whether it is
`preserve`d or `adopt`ed); and `requires_preview`.

Some actions, and when each is the one to take:

- `restart_refinement` ("Start again with the current configuration") starts a fresh Refinery run
  for the ticket, adopting the current configuration, workflow contract and ticket instructions; the
  old run and its events are kept. It is the refinement re-dispatch, offered only while the ticket
  is still in refinement — at `research_needed`, `specification` or `planning` — with no live
  Refinery run and no open clarification (otherwise `REFINEMENT_RESUME_STAGE_REQUIRED`,
  `LIVE_REFINERY_RUN_EXISTS` or `CLARIFICATION_PENDING`).
- `replay_from_node` re-runs one node of a finished run and what depends on it, reusing the rest of
  the run's frozen work. Choose it over `restart_refinement` when one step went wrong and the rest
  of the run is worth keeping; a Refinery run with no replayable step answers `instead:
  restart_refinement`.
- `resolve_target_conflict` ("Resolve merge conflicts") returns a delivered pull request that the
  forge reports as conflicting with its target branch to implementation, to merge the target and
  deliver again. It is refused with `PULL_REQUEST_MERGEABLE` when there is no conflict,
  `NO_PULL_REQUEST`, `PULL_REQUEST_MERGED` or `PULL_REQUEST_CLOSED`.
- `remove_dependency` (family `ticket_control`) removes the ticket's declared dependency on the
  prerequisite its target names; name it with `--prerequisite <id>`. Once work has started the
  dependency can no longer change (`DEPENDENCY_TARGET_FROZEN`).

- `pidgen ticket actions <ref>` reads `GET /tickets/{ref}/actions`, passing `--family`, `--run`,
  `--node` and `--prerequisite` as the `family`, `run_id`, `node_id` and `prerequisite_id`
  filters. `--decision <decision_key>` keeps the actions whose `target.decision_key` it names; the
  route publishes no filter for it, so the CLI applies it to the answer and sends none. `data` is
  `{ticket_id, actions}`; each
  action is the server's decision unchanged plus `state` (`allowed`, or `blocked` when either gate
  refuses), `blocked_by` (`admissible` or `authorized`, else null), `refusal` (the blocking gate's
  `code`, `message` and `instead`, else null) and `recommended_reason`. It changes nothing. An
  unknown ticket exits 4 with the server's `TICKET_NOT_FOUND`; a caller without `ticket.read` exits
  3.
- `pidgen ticket act <ref> <action>` (the action may be written `retry-run`) reads the decisions,
  narrowed by `--family`, `--run`, `--node`, `--fan-out-key`, `--prerequisite`, `--criterion`
  (passed as the `criterion_index` filter and matched against each target's `criterion_index`) and
  `--decision` (matched against each target's `decision_key`), and takes the one for that action.
  Then, with [Preview and apply](preview-and-apply.md) and the shared flags:
  - Without `--apply` it previews with `POST /tickets/{ref}/actions/preview`, sending
    `{action, target}` (and `followup`, `exception`, `criterion_override` or `plan_correction`,
    when the flags for them are given), and changes nothing. `data` is the preview — `preview_digest`,
    `required_acknowledgements`, `action`, `target`, `consequence` and the action's `effects` — and
    the `decision` it previewed.
  - `--apply` previews again and executes that preview with `POST /tickets/{ref}/actions/execute`,
    sending the same `action`, `target` and choices, its `preview_digest`, the `acknowledgements` given with
    `--acknowledge <code>...` (or `--ack`, repeatable), `--reason`, `--note` (sent as `note` only
    when given) and an idempotency key the CLI derives from the command, target, digest and
    acknowledgements (`--idempotency-key` sets it). The body is checked against the published
    request first: `reason` at most 10240 characters, `note` at most 4000, `idempotency_key` 1–255
    characters and at most 20 acknowledgements; anything longer exits 2 with `INPUT_INVALID` and
    nothing is executed. A
    code the preview requires but you did not pass exits 6 with `ACKNOWLEDGEMENT_REQUIRED`,
    `error.details.missing` and the preview, and nothing is executed; the CLI never acknowledges on
    your behalf. `--apply --digest <d>` executes exactly that earlier preview without previewing
    again.
  - A `200` is settled. A `202` is followed on its `status_url` until it settles (`--wait`, the
    default; `--timeout` bounds it and a timeout exits 8); `--no-wait` returns at once with
    `handle`, the status route. `data` after an apply: `settled`, `result`, `idempotency_key`
    and, while unsettled, `handle`. `result` is the server's execute result: `command_id` (the
    durable command), `ticket_id`, `status` (`applied` or `applying`), `disposition_code` (null
    unless the server recorded one), `workflow_run_id` (the run the action started or acts on, else
    null) and `status_url` (the command's status route), beside the `action` and `target`. It has
    no `result` object.
- A blocked decision is refused before anything is previewed: `error.code` and `error.message` are
  its refusal's, `error.details` carries `action`, `label`, `target`, `blocked_by` and `instead`
  (and `next`, the command for the alternative), and it exits 5 when not admissible or 3 when not
  authorized. A refused preview or execute keeps the server's refusal code and message and exits
  non-zero: 5 for a refusal (409), 3 when not permitted (403), 4 when the target is gone (404), and
  6 for `PREVIEW_STALE` (preview again) or `ACKNOWLEDGEMENT_REQUIRED`.
- An action the ticket does not offer for the target exits 5 with `ACTION_NOT_OFFERED`,
  `error.details.offered` listing what it offers. An action offered on several targets without
  `--run`, `--node`, `--fan-out-key`, `--prerequisite`, `--criterion` or `--decision` to choose one
  exits 2 with `ACTION_TARGET_AMBIGUOUS` and `error.details.targets`. Neither previews anything.
  With `--decision`, `ACTION_NOT_OFFERED` names it in `error.details.decision_key`, and with
  `--criterion` in `error.details.criterion_index`. A server that does not publish a kind does not
  offer it, so the new kinds report `ACTION_NOT_OFFERED` there, as any kind a ticket does not offer.
- A missing or unknown action, a missing or malformed ref, an unknown `--family`, an empty or
  overlong `--run` (over 128 characters), `--node` (256), `--prerequisite` (128),
  `--fan-out-key` (200), `--decision` (256) or `--delegate-to` (128), a `--criterion` that is not a
  whole number from 0, `--digest` without `--apply`, a malformed acknowledgement code, a follow-up
  choice, or a plan, start, approve or override choice, that the action does not take, that the
  action requires and was not given, or that is not valid (see below), or an extra argument is
  `CLI_USAGE` (exit code 2) and sends nothing.

#### Decision follow-up

A decision that waits on a person — a clarification, a delivery review or a hold review — is
followed up: it is reminded, escalated and, if it stays unanswered, held, and a hold comes back
for review. The `decision_followup` family lets a person act on that. Its actions target a
`decision`, named with `--decision <decision_key>` (the `decision_key` an attention finding
carries).

| Action | Takes | Does |
|---|---|---|
| `snooze_reminders` | `--until <date-time>` | Stops your reminders until that time |
| `defer_decision` | `--until <date-time>` | Defers the decision to that time, no later than the decision's `defer_latest` |
| `hold_decision` | — | Holds the decision; `--reason` is recorded with the hold |
| `delegate_decision` | `--delegate-to <user_id>` | Hands the decision to that user |
| `proceed_on_assumption` | — | Proceeds on the decision's recommended answer |
| `keep_holding` | `--until <date-time>` | Keeps a hold that is due for review, to be reviewed again at that time |

The decision's `label` and `consequence` say exactly what the server will do.

- `--until <date-time>` is an ISO 8601 date-time with an offset — `2026-10-12T09:00:00Z` or
  `2026-10-12T09:00:00+02:00`; seconds are optional. It is accepted only with `snooze_reminders`,
  `defer_decision` and `keep_holding`. `--delegate-to <user_id>` is accepted only with
  `delegate_decision`. Either one with another action, a `--until` that is not a date-time with an
  offset (a date alone, a time with no offset, a 30th of February), or an empty value is
  `CLI_USAGE` (exit code 2), and nothing is sent. The CLI does not judge whether the time is in
  the future, how far away it is, or whether the user may take the decision: the server does.
- The choices travel as `followup: {until, delegate_to}` on **both** the preview and the execute,
  with `null` for the one not given and no `followup` at all when neither is given. The preview's
  digest covers them, so execute with the choices you previewed: a different choice at the execute
  is `PREVIEW_STALE` (exit 6; preview again), and so is `--apply --digest <d>` with other choices
  than the digest's preview. `--until` is sent normalised to RFC 3339 (upper-case `T` and `Z`,
  seconds present); its instant is the one you gave.
- A decision the server blocks — in `pidgen ticket actions` its `refusal`, and in `pidgen ticket act`
  the error — or refuses at the preview or the execute reports the server's code and sentence and
  exits 5, as every other action does. The refusals the follow-up actions add:

  | Code | Sentence |
  |---|---|
  | `FOLLOW_UP_NOT_FOUND` | This decision has no follow-up to change. |
  | `FOLLOW_UP_TIME_PAST` | That time has already passed. Choose a later one. |
  | `DEFER_TOO_LONG` | That is later than this decision may be deferred. `error.details.latest` is the latest time allowed. |
  | `DECISION_HELD` | This decision is held, so this follow-up does not apply. |
  | `HOLD_ALREADY_REQUESTED` | A hold has already been requested for this decision. |
  | `HOLD_NOT_APPLICABLE` | This decision cannot be held. |
  | `DELEGATE_NOBODY` | Name the person to delegate this decision to. |
  | `DELEGATE_NOT_ELIGIBLE` | That person cannot take this decision. |
  | `NO_RECOMMENDED_ANSWER` | This decision has no recommended answer to proceed on. |
  | `HOLD_REVIEW_NOT_DUE` | This hold is not due for review yet. |
  | `HOLD_REVIEWER_REQUIRED` | Only a reviewer of this hold may decide it. |

  `pidgen review attention --addressee on_hold` lists the holds due for review. The published
  follow-up read, `GET /tickets/{ref}/follow-up` (the decisions waiting on a person and the holds
  concerning a ticket), has no command yet; `pidgen api get /tickets/PIDGEN-4/follow-up` reads it.

#### Plan, start, approve and override

These kinds belong to the `decision_answers` family: the answers a person gives while a ticket is
planned, started and reviewed. Except `override_acceptance_criterion`, which acts on one acceptance criterion, they act on the
ticket.

| Action | Takes | Does |
|---|---|---|
| `plan_work` | — | Plans the ticket's work |
| `start_work` | — | Starts the ticket's work; the preview shows its four checks |
| `ask_before_starting` | — | Asks before starting; the preview lists the plan's decisions |
| `correct_plan_decision` | `--answer <decision>=<text>` or `--alternative <decision>=<option>`, repeatable, at least one | Corrects the answers of plan decisions |
| `approve_delivery` | — | Approves the delivery |
| `approve_with_exception` | `--exception-reason <text>` | Approves the delivery although acceptance criteria are not proven, with the reason on record |
| `request_delivery_changes` | `--note <text>` | Sends the delivery back, `--note` saying what should change |
| `override_acceptance_criterion` | `--criterion <index>`, `--criterion-status passing\|failing\|pending` and `--override-reason <text>` | Sets one acceptance criterion's status, with the reason on record |

The decision's `label` and `consequence` say exactly what the server will do.

- `--criterion <index>` names an acceptance criterion by its position in the ticket's list,
  counting from 0, as a target filter like `--prerequisite`: it is passed as the actions route's
  `criterion_index` filter and matched against each decision's `target.criterion_index`.
  `override_acceptance_criterion` is offered once for each criterion, so name the one to override;
  without `--criterion` and with several offered it exits 2 with `ACTION_TARGET_AMBIGUOUS`. It is
  accepted with any action; one that is offered for no such criterion is `ACTION_NOT_OFFERED`.
- `--exception-reason <text>` is sent as `exception: {reason}`; `--criterion-status` with
  `--override-reason` as `criterion_override: {status, reason}`; `--answer` and `--alternative` as
  `plan_correction: {answers}`. Each `--answer <decision>=<text>` answers plan decision
  `<decision>` (its number, counting from 0) in your own words (`free_text`), and each
  `--alternative <decision>=<option>` with one of the options it offers (`alternative`): an answer
  carries exactly one of the two, the text after the first `=` is taken whole, answers are sent in
  the order of their decisions, and a decision answered twice, or more than 50 answers, is a usage
  error. The choices go to **both** the preview and the execute, as the follow-up choices do: the
  preview's digest covers them, and another choice at the execute is `PREVIEW_STALE` (exit 6;
  preview again). A reason is trimmed, must not be blank and is at most 2000 characters.
- `request_delivery_changes` requires `--note`: the execute's existing `note` (at most 4000
  characters) is what should change. `--note` is required with or without `--apply`, so that what
  is previewed is what is applied; the preview does not send it.
- A choice flag given for a kind that does not take it — `--exception-reason` with anything but
  `approve_with_exception`, `--criterion-status` or `--override-reason` with anything but
  `override_acceptance_criterion`, `--answer` or `--alternative` with anything but
  `correct_plan_decision` — and a kind that requires a choice given without it
  (`approve_with_exception` without `--exception-reason`, `override_acceptance_criterion` without
  `--criterion-status` and `--override-reason`, `correct_plan_decision` without `--answer` or
  `--alternative`, `request_delivery_changes` without `--note`) is `CLI_USAGE` (exit code 2), and
  nothing is sent, not even the listing of actions. So is an unknown `--criterion-status` (only
  `passing`, `failing` and `pending`), a blank value, and an answer that is not `<decision>=<text>`
  with a whole decision number from 0.
- The preview prints what the action would do, as the server reports it, in `data.effects`:
  for `start_work`, `effects.checks`, the four checks that must pass before work starts; for
  `ask_before_starting` and `correct_plan_decision`, `effects.decisions`, the plan's decisions with
  their options. The CLI passes them through unchanged. `pidgen ticket actions` with `--family
  decision_answers` lists these decisions, each blocked one with its `refusal`.
- A decision the server blocks, or a preview or execute it refuses, reports the server's code and
  sentence and exits 5, as every other action does, naming in `error.details.instead` the action to
  take instead when there is one. The refusals these kinds add:

  | Code | Sentence |
  |---|---|
  | `MUST_CRITERIA_NOT_PASSING` | Not every MUST acceptance criterion is passing. Approve with an exception, or ask for changes. |
  | `EXCEPTION_REASON_REQUIRED` | Say why you approve although criteria are not proven. |
  | `INDEPENDENT_APPROVAL_REQUIRED` | Someone other than the author of this work must approve its delivery. |
  | `REVIEW_NOT_OPEN` | This ticket's delivery is not open for review. |
  | `FEEDBACK_REQUIRED` | Say what should change in the delivery. |
  | `OVERRIDE_REASON_REQUIRED` | Say why you are changing this criterion's status. |
  | `CRITERION_NOT_FOUND` | This ticket has no acceptance criterion at that position. |
  | `START_CHECKS_FAILED` | A check that must pass before work starts did not pass. |
  | `PLAN_DECISION_NOT_OPEN` | That plan decision is not open for an answer. |
  | `WORK_ALREADY_STARTED` | Work on this ticket has already started. |
  | `PLANNING_NOT_AVAILABLE` | Planning is not available for this ticket. |
  | `BACKLOG_STAGE_REQUIRED` | This ticket must be in the backlog for this action. |

  The CLI never judges these: whether the criteria pass, who is independent and whether the checks
  hold are the server's to say, and the sentence is the server's, which may differ from the one
  published in the contract.
- A delivery review in `pidgen review attention` carries `unproven_criteria` (the acceptance criteria
  not yet proven passing, or null) and `reviewed_revision` (the revision under review, or null) on
  its finding, passed through unchanged. The published review decision route,
  `POST /tickets/{ref}/review/decisions`, takes an optional `exception_reason` and answers with
  `reviewed_revision`, `exception_reason` and `unproven_criteria` on its decision; it has no
  command, and `pidgen api post /tickets/PIDGEN-4/review/decisions` reaches it.

### ticket retry and replay

```console
$ pidgen ticket retry PIDGEN-4 [--run <id>]
$ pidgen ticket retry PIDGEN-4 --apply --digest sha256:9f… [--ack ambiguous-effects] [--reason "…"]
$ pidgen ticket replay PIDGEN-4 --node implement [--run <id>]
$ pidgen ticket replay PIDGEN-4 --node implement --apply --digest sha256:9f… [--no-wait]
```

- Both recover one workflow run of the ticket through the actions routes, keeping their flags.
  They read the ticket's recovery decisions (`GET /tickets/{ref}/actions?family=recovery`, with
  `run_id` from `--run` and, for a replay, `node_id` from `--node`) and take one:
  - `pidgen ticket retry` takes `retry_run`, a fresh attempt of the whole run. For a Refinery run it
    takes `restart_refinement` instead when the decision says so: the `retry_run` decision is
    blocked with `instead: restart_refinement`, or the server offers only `restart_refinement`.
  - `pidgen ticket replay` takes `replay_from_node` for the node named by `--node`: it re-runs that
    node and what depends on it, reusing the rest.
- `--run <id>` names the run. Without it the command takes the first matching decision, the
  newest run's.
- A blocked decision exits with its refusal's code and message before anything is previewed — 5
  when not admissible (for example `REFINERY_SELECTIVE_REPLAY_REQUIRED`, or
  `REPLAY_REQUIRES_PRODUCER`, with `error.details.instead`), 3 when not authorized. No matching
  decision exits 5 with `ACTION_NOT_OFFERED`; an unknown ticket exits 4 with the server's
  `TICKET_NOT_FOUND`.
- Without `--apply` it previews the decision with `POST /tickets/{ref}/actions/preview`
  (`{action, target}`) and changes nothing; `data` is the preview, as for `pidgen ticket act`.
- `--apply --digest <d>` executes with `POST /tickets/{ref}/actions/execute`, sending the action,
  target, digest, the `--ack` acknowledgements, `--reason` and the idempotency key; a changed
  decision is the server's `PREVIEW_STALE` and a missing acknowledgement its
  `ACKNOWLEDGEMENT_REQUIRED`, both exit 6 with `error.details.next` saying what to do. `--apply`
  without `--digest` executes a fresh preview only when it requires no acknowledgement; otherwise
  it exits 6 with `DIGEST_REQUIRED` and the preview.
- A `202` is followed on its `status_url` until it settles (`--wait`, the default); `--timeout`
  bounds it and a timeout exits 8. `--no-wait` returns at once. `data` after an apply is as for
  `pidgen ticket act`. The server's other refusals keep their codes and exit 5 (or 4 for a missing
  target), also when reported by the status route.
- A missing or malformed ref, `pidgen ticket replay` without `--node`, an empty `--node` or `--run`
  (or one longer than the server accepts), `--digest` without `--apply`, a malformed `--ack` code,
  or an extra argument is `CLI_USAGE` (exit code 2) and sends nothing.
- The CLI does not call the older recovery routes (`POST /tickets/{ref}/recovery/preview`,
  `POST /tickets/{ref}/recovery`, whose request names its `action` and `source_run_id`); they stay
  in the published contract until the App Service retires them.

### ticket reopen

```console
$ pidgen ticket reopen PIDGEN-4
$ pidgen ticket reopen PIDGEN-4 --apply --digest sha256:9f… [--reason "…"]
```

- Reopens a completed ticket whose completion cannot be proven — it has no delivery evidence, or
  none of its execution runs ever succeeded — returning it to `awaiting_review` and superseding its
  delivery record. It follows [Preview and apply](preview-and-apply.md) with the shared flags.
- Without `--apply` it previews with `POST /tickets/{ref}/reopen/preview` and changes nothing.
  `data` is the preview: `plan` (`ticket_id`, `from_stage` `completed`, `to_stage`
  `awaiting_review`, `violated_invariants` such as `completed_without_delivery` or
  `completed_without_successful_run`, an `invariant_details` sentence for each, the `delivery` it
  supersedes or `null`, and `execution_run_statuses`), `preview_digest` and
  `required_acknowledgements` (empty when none).
- With `--apply --digest <d>` it sends `POST /tickets/{ref}/reopen` with the digest, the
  acknowledgements, `--reason` and the idempotency key. `--apply` without `--digest` applies a
  fresh preview only when it requires no acknowledgement; otherwise it exits 6 with
  `DIGEST_REQUIRED` and the preview. A ticket that changed since the preview exits 6 with the
  server's `PREVIEW_STALE`, and a missing acknowledgement exits 6 with `ACKNOWLEDGEMENT_REQUIRED`;
  `error.details.next` says what to do.
- A reopen settles in the request. `data` after an apply: `settled` (`true`), `result` (the
  server's result: `command_id`, `status` `applied`, `ticket_id`, `from_stage`, `to_stage`,
  `violated_invariants`, `deliveries_superseded`, `findings_resolved`, `preview_digest` and
  `reason`) and `idempotency_key`.
- A ticket that cannot be reopened is refused, by the preview or the apply, with the server's code
  and exits 5: `REOPEN_NOT_JUSTIFIED` (its completion invariants hold, so there is nothing to
  repair), `REOPEN_NOT_COMPLETED` (it is not completed), `ACTIVE_ATTEMPT_EXISTS` (a run is still
  active on it) or `REOPEN_REQUIRES_HUMAN`; `COMMAND_IDEMPOTENCY_CONFLICT` also exits 5. An unknown
  ticket exits 4 with `TICKET_NOT_FOUND`.
- A missing, empty, `.` or `..` ref, `--digest` without `--apply`, a malformed `--ack` code, or an
  extra argument is `CLI_USAGE` (exit code 2) and sends nothing.

### ticket cancel

```console
$ pidgen ticket cancel PIDGEN-4 [--discard-workspace] [--close-pr]
$ pidgen ticket cancel PIDGEN-4 --apply --digest sha256:9f… --ack cancels-descendants [--reason "…"]
$ pidgen ticket cancel PIDGEN-4 --apply --digest sha256:9f… --close-pr --ack cancels-descendants
$ pidgen ticket cancel PIDGEN-4 --apply --digest sha256:9f… --superseded-by PIDGEN-9 [--no-wait]
```

- Cancels a ticket and every descendant: from the apply on no work in its subtree starts again, its
  runs are halted and its tickets move to `abandoned` as the cancellation converges. It follows
  [Preview and apply](preview-and-apply.md) with the shared flags (`--apply`, `--digest`, `--ack`,
  `--reason`, `--idempotency-key`, `--wait`/`--no-wait`).
- Without `--apply` it previews with `POST /tickets/{ref}/cancellation/preview`, sending
  `retain_workspace` (`true`, or `false` with `--discard-workspace`) and `close_pull_request`
  (`false`, or `true` with `--close-pr`), and sends nothing else.
  `data` is the preview: `plan` (`ticket_id`, `ticket_key`, `cancelled_tickets` — the ticket and
  every descendant it cancels, deepest first, each with `ticket_key`, `title` and `stage` —
  `descendant_count`, `blocked_dependents` left blocked outside the subtree (they are not
  cancelled), the `workspace` it governs or `null`, with `branch`, `is_owner` and `released`,
  `retain_workspace`, the `pull_request` of the ticket's delivery or `null` — its `url`, `number`
  and `state` (`open`, `closed` or `merged`) — and the ticket's latest `delivery_operation` or
  `null`), `preview_digest` and `required_acknowledgements`: `cancels_descendants` when
  descendants are cancelled, `discards_workspace` when the workspace branch is deleted. A
  `delivery_operation` is a push, a pull-request update or an apply a worker is running or ran for
  the ticket: its `operation_id`, `kind` (`push`, `pr_update` or `apply`), `ownership_generation`,
  `worker` (`host_id` and `name`), `started_at`, `observed_at` and `state` (`in_flight`, `settled`
  or `unknown`). The CLI prints both as the server answers them.
- **The pull request.** `--close-pr` closes the ticket's open, unmerged pull request as part of the
  cancellation. **Without it the default is `close_pull_request: false`, and an open pull request is
  left open**: cancelling a ticket does not touch its pull request unless you ask. A merged pull
  request is never touched. The choice goes to the preview and to the apply, and the preview's
  digest covers it, so an apply whose choice differs from its preview's — `--close-pr` on one and
  not the other — exits 6 with the server's `PREVIEW_STALE`: preview again with the choice you
  want. Preview with `--close-pr` and apply with `--close-pr`.
- With `--apply --digest <d>` it sends `POST /tickets/{ref}/cancellation` with the same
  `retain_workspace` and `close_pull_request`, the `disposition`, the digest, the acknowledgements
  given with `--ack` (never added on your behalf), `--reason` and the idempotency key. `--disposition` is `cancelled` (the
  default: stop now; it may be wanted later), `wont_do` (or `wont-do`: deliberately not doing it) or
  `superseded`; `--superseded-by <ref>` names the replacing ticket, is sent as `superseded_by`, and
  implies `superseded`. `--apply` without `--digest` applies a fresh preview only when it requires
  no acknowledgement; otherwise it exits 6 with `DIGEST_REQUIRED` and the preview.
- A subtree, blocked dependents or workspace that changed since the preview — or a
  `--discard-workspace` that differs from the preview's — exits 6 with the server's
  `PREVIEW_STALE`: preview again. A missing acknowledgement exits 6 with `ACKNOWLEDGEMENT_REQUIRED`,
  `error.details.missing` listing the codes and `error.details.next` the `--ack` flags that accept
  them.
- The published apply answers `200`. `data` after an apply: `settled` (`true`), `result` (the
  server's cancellation: `cancellation_id`, `status` `applied`, `state` — `accepted`, `halting` or
  `converged` — `ticket_id`, `disposition`, `superseded_by`, `retain_workspace`,
  `close_pull_request`, `pull_request_close`, `reason`, `cancelled_ticket_ids` and `requested_at`)
  and `idempotency_key`. `pull_request_close` says what became of the pull request:
  `left_open` (the default: an open pull request stays open), `pending` (closing it is still to
  happen), `closed`, `failed` (it could not be closed), `merged` (it was already merged, so it is
  left as it is) or `not_required` (there was none to close). Repeating the apply answers the
  same cancellation and starts nothing new. Should the server answer `202`, `--wait` (the default)
  follows the result's `status_url` until it settles, bounded by `--timeout` (a timeout exits 8), and
  `--no-wait` returns at once with `settled: false` and the status route as `handle`.
- A ticket that cannot be cancelled is refused, by the preview or the apply, with the server's code
  and exits 5: `ALREADY_TERMINAL` (it is completed or abandoned; a failed ticket can be
  cancelled), `ALREADY_DELIVERED` (its change was merged; undo it with new work),
  `DELIVERY_IN_FLIGHT` (a delivery operation is in flight; retry once it settles) or
  `PUBLICATION_RESULT_UNKNOWN` (a delivery operation's result is unknown; it must be settled
  first). The last two keep their code and exit status and print the operation in
  `error.details.operation`, with the same fields as the preview's `delivery_operation`, so you can
  see which operation, on which worker, blocks the cancellation. Nothing is cancelled on a refusal.
  An unknown ticket exits 4 with `TICKET_NOT_FOUND`; an unknown `--superseded-by` ticket is the
  server's `SUPERSEDING_TICKET_NOT_FOUND`.
- A missing, empty, `.` or `..` ref, `--digest` without `--apply`, a malformed `--ack` code, an
  unknown `--disposition`, `--disposition superseded` without `--superseded-by`, `--superseded-by`
  with another disposition or a malformed ref, or an extra argument is `CLI_USAGE` (exit code 2) and
  sends nothing.

### ticket clarify

```console
$ pidgen review list
$ pidgen ticket clarify PIDGEN-7 -f answers.yaml
```

- Answers, or abandons, the questions a ticket's refine gate is parked on. `pidgen review list` lists
  the tickets waiting on one, and `GET /tickets/{ref}/clarification` (for example through
  `pidgen api get`) shows its questions, each with the `key` to answer it under, its `answer_type`
  (`text`, `boolean`, `single_select` from `choices`, or `multi_select`) and whether it is
  `required`.
- The file is the request body, as JSON or YAML (`-f -` reads standard input): `answers`, each
  question's `key` to its answer; optionally `outcome` — `answered` (the default) or `abandoned`,
  which is **deprecated**: against a server that publishes decision follow-up it now places a hold
  on the decision and leaves the question open, where it used to close the clarification — a `note`
  saying why, `gate_generation` and `idempotency_key`. The `--help` says so too.

  ```yaml
  answers:
    login_method: password
    remember_me: true
  note: Agreed with the product owner.
  ```

  It is checked against the answer schema before anything is sent; a file that does not parse or
  match, or an `answered` file with no answer, exits 2 with `INPUT_INVALID`.
- The CLI first reads the open clarification with `GET /tickets/{ref}/clarification`, then sends
  the file with `POST /tickets/{ref}/clarification`. When the file names no `gate_generation`, the
  CLI adds the one that read reported (when a run holds a live gate), so the answers settle the
  question you saw; this is the one field it adds to the file.
- `data` is the server's result: `outcome`, `assumptions_written` (each write the answers made to
  the ticket, in question order), `gate_generation`, `intervention_id`, `resolved_by`,
  `gate_signalled`, `decision`, and the `refinement_command_id` and `refine_workflow_id` of the
  fresh refinement run the ticket resumes in, or `dispatch_error` saying why resuming failed (the
  answers are kept and the server retries), and `hold`: the hold an `abandoned` outcome placed,
  else null.
- A ticket with no open question is a refusal, not a missing ticket: the server's
  `CLARIFICATION_NOT_FOUND`, from the read or the answer, exits 5 with that code. An open record
  that addresses an earlier gate generation (the read's `stale`) exits 5 with `INTERVENTION_STALE`
  and sends no answers, as does the server's own `INTERVENTION_STALE`; read the ticket again. The
  server's answer refusals keep their codes and exit 2: `CLARIFICATION_ANSWER_REQUIRED`,
  `CLARIFICATION_GENERATION_STALE` (the gate moved past the file's `gate_generation`),
  `CLARIFICATION_UNKNOWN_QUESTION`, `CLARIFICATION_ANSWER_TYPE_INVALID`,
  `CLARIFICATION_CHOICE_INVALID` and `CLARIFICATION_QUESTIONS_REQUIRED`. An unknown ticket, or
  another Account's, exits 4 with `TICKET_NOT_FOUND`.
- No `-f`, a missing, empty, `.` or `..` ref, or an extra argument is `CLI_USAGE` (exit code 2) and
  sends nothing.

### ticket instructions

```console
$ pidgen ticket instructions PIDGEN-7
$ pidgen ticket instructions PIDGEN-7 --kind steer
```

- Lists the instructions of one ticket, across its sessions and in every state
  (`GET /tickets/{ref}/instructions`). `data` is the server's array unchanged, each instruction as
  [`pidgen session`](#session) describes it: its `state`, with the live path's `dispatched` and
  `accepted`, its `mode`, and, for an instruction a running session returned, its `return_code`.
  The help (`--help`) describes each state. `--kind steer` or `--kind request_changes`
  is sent as `kind` and limits the list to steers or to `request_changes` instructions; without it
  the CLI sends no `kind` and the server lists every kind.
- An unknown ticket, or another Account's, exits 4 with `TICKET_NOT_FOUND`. An unknown `--kind`, a
  `--kind` with no value, a missing, empty, `.` or `..` ref, or an extra argument is `CLI_USAGE`
  (exit code 2) and sends nothing.

### ticket history

```console
$ pidgen ticket history PIDGEN-7
$ pidgen ticket history PIDGEN-7 --show people
$ pidgen ticket history PIDGEN-7 --after 40 --limit 20
$ pidgen ticket history PIDGEN-7 --all
```

- Reads what happened to one ticket, oldest first (`GET /tickets/{ref}/history`). In JSON mode,
  it prints one envelope. `data` is the server's page: `ticket_id`, `entries` and `next_after`. Each entry
  has `sequence`, `occurred_at`, `kind` (`stage_change`, `command`, `review_decision`,
  `cancellation`, `intervention`, `owner_change`, `epic_change` or `edit`), `category` (`people`
  or `observations`), `actor` (`kind`, `id` and `display_name`, or `null`), `summary`, `reason`,
  `status` and `code`; the last three are `null` when the entry has none. `meta` is the response's.
- `--show` is sent as `show` and keeps `people` (what a person did or decided), `observations`
  (what the system recorded) or `everything`, the route's default. `sequence` is the entry's
  position in the ticket's *whole* history and stays the same under a filter, so a filtered list
  can skip numbers. `--after <n>` is sent as `after` and keeps the entries whose `sequence` is
  greater than `n`. `--limit <n>` is sent as `limit` and caps a page at `n` entries, 1 to 200; the
  server's default is 100. A flag not given is not sent.
- Without `--all` the command reads one page. When more follow, `next_after` is the `sequence` to
  pass as `--after` to read the next page; on the last page it is `null`.
- With `--all` the command follows `next_after` until it is `null`, asking each page with the same
  `--show` and `--limit` (`--limit` is the page size), and starting after `--after` when given.
  `data.entries` then holds every entry in order and `data.next_after` is `null`; `meta` is the
  first page's. A refusal on any page fails the command rather than printing part of the history.
  A `next_after` that does not move on, or pages still coming after 1000, is `UNEXPECTED_RESPONSE`
  (exit code 1); a larger `--limit` needs fewer pages.
- An unknown ticket, or another Account's, or one you cannot read, is the server's `404`
  `TICKET_NOT_FOUND` (exit code 4).
  An unknown `--show`, an `--after` that is not a whole number from 0, a `--limit` that is not a
  whole number from 1 to 200, an option with no value, a missing, empty, `.` or `..` ref, or an
  extra argument is `CLI_USAGE` (exit code 2) and sends nothing.

## intent

| Command | Does | Route |
|---|---|---|
| `pidgen intent submit -f <file> [--submission-key <key>]` | Submit prose work; returns a ticket or clarification questions | `POST /intents` |
| `pidgen intent respond <conversation> -f <answers>` | Answer, assume, hand on or leave open an intake request's questions | `POST /intents/{conversation_id}/respond` |
| `pidgen intent list [--project <ref>] [--state clarifying\|created\|withdrawn]` | List intake requests | `GET /intents` |
| `pidgen intent show <conversation>` | Show one intake request | `GET /intents/{conversation_id}` |
| `pidgen intent withdraw <conversation> [--reason <text>]` | Withdraw a request still waiting on answers | `POST /intents/{conversation_id}/withdraw` |

A request that needs answers is an **intake request**: a persisted record that never expires, is
named by its key in the Account, `REQ-{n}`, and has structured questions. The intent commands print
that key wherever the server names the request (`conversation_id`, `request_id`, and a nested
`request`'s `request_id`), and print the request's internal id only when the server has no key for
it. Every `<conversation>` argument takes the key (or that id) and is sent as given; the server
resolves it inside the Account, key first. These routes and fields are published in the public API. In JSON mode,
each command prints one envelope; terminal stdout defaults to human-readable output.

- `pidgen intent submit -f <file> [--submission-key <key>]` — submits prose work from a JSON or YAML
  file (`-f -` reads standard input; see [Input files](#input-files)). The body is checked against
  the submit request schema and sent as written: `title` and `objective` are required, `project_id`
  names the project by id or ticket-key prefix, and `approval_mode`, `merge_policy`, `target_lane`,
  `epic_id`, `team_member_id`, `references`, `artifact_upload_ids` and `submission_key` are
  optional; never send `source_user`, since the creator is the caller. `--submission-key <key>` is
  sent as `submission_key` (1–200 characters): submitting again with the same key and the same body
  returns the same outcome and creates nothing new, so a retry after a lost response is safe, and
  the same key with a different body is `SUBMISSION_KEY_REUSED` (exit code 5). A body file that
  already has a `submission_key` keeps it unless the option is given, which replaces it; an empty
  or over-long key is `CLI_USAGE` (exit code 2) and sends nothing. `data` is the server's result; switch on `data.outcome`:
  - `created` — the intent became a ticket in Backlog: `ticket_id`, `ticket_key`, `stage`,
    `ticket_url`, `target_lane`, `auto_promotion`, and the `refinement_command_id` or the
    `command_error` saying why refinement did not start; a server that publishes durable requests
    adds the `request_id` and `assumptions_recorded`, how many questions were settled by assuming
    their recommendation;
  - `needs_clarification` — nothing was created: `conversation_id` and `questions`, the questions
    to answer with `pidgen intent respond`; a server that publishes durable requests adds
    `request_id` and `request`, the request with its structured questions (see `intent show`). The
    request never expires.

  A body that does not parse or match the schema exits 2 with `INPUT_INVALID` and sends nothing.
  The server's refusals keep their codes: `PROJECT_NOT_FOUND`, `EPIC_NOT_FOUND` and
  `TEAM_MEMBER_NOT_FOUND` exit 4; `PROJECT_REQUIRED`, `READY_LANE_REQUIRES_TEAM_MEMBER`,
  `EPIC_PROJECT_MISMATCH` and `TEAM_MEMBER_ARCHIVED` exit 2; `FORBIDDEN` exits 3;
  `SUBMISSION_KEY_REUSED` exits 5. No `-f`, or an argument, is `CLI_USAGE` (exit code 2).
- `pidgen intent respond <conversation> -f <answers>` — settles questions of the request
  `pidgen intent submit` returned, by the key it printed as `conversation_id` (e.g.
  `pidgen intent respond REQ-12 -f answers.yaml`). The file is the request body, as JSON or
  YAML (`-f -` reads standard input): `answers`, each naming its question by `question_id` (from
  the request's `questions`) or, as before, by its 0-based `question_index`, with an `outcome`:

  | `outcome` | Does |
  |---|---|
  | `answer` (the default) | records `answer`, which is required for this outcome |
  | `use_recommendation` | assumes the question's recommendation; no `answer` |
  | `ask_teammate` | asks the teammate named by `ask_user_id`; no `answer` |
  | `leave_open` | leaves the question open; no `answer` |

  and optionally `delegate: true` to create the ticket now even if questions remain; with
  `delegate: true`, `answers` may be empty. The file is checked against the respond request schema
  before anything is sent: an answer that names no question, an `answer` outcome with no text, an
  unknown outcome, or no answers without `delegate` is `INPUT_INVALID` (exit code 2).

  ```yaml
  answers:
    - question_id: q-example-1
      outcome: use_recommendation
    - question_id: q-example-2
      answer: Email and password.
    - question_index: 2
      answer: Yes, for 30 days.
  delegate: false
  ```

  `data` is the server's result; switch on `data.outcome`: `created` is the ticket, as for
  `intent submit`, with `request_id` and `assumptions_recorded`, and `still_needs_clarification`
  means the answers were recorded and questions remain (`message` says so, and `request` is the
  updated request): answer them, or respond with `delegate: true`. The request never expires, so
  there is no deadline to answer by; withdraw it with `pidgen intent withdraw` if the work is no
  longer wanted. A conversation that is unknown
  or another Account's exits 4 with the server's `CONVERSATION_NOT_FOUND`. `REQUEST_WITHDRAWN` (the
  request was withdrawn) exits 5. `QUESTION_NOT_FOUND` (no such `question_id`), `ANSWER_EMPTY`,
  `NO_RECOMMENDATION` (`use_recommendation` on a question with none), `ASKEE_NOT_ELIGIBLE` and
  `QUESTION_INDEX_INVALID` (an answer names a question the request does not have; nothing is
  recorded) exit 2, as do `READY_LANE_REQUIRES_TEAM_MEMBER`, `EPIC_PROJECT_MISMATCH` and
  `TEAM_MEMBER_ARCHIVED`; `PROJECT_NOT_FOUND`, `EPIC_NOT_FOUND` and `TEAM_MEMBER_NOT_FOUND` exit 4;
  `FORBIDDEN` exits 3. A missing, empty, `.` or `..` conversation, more than one, or no `-f` is
  `CLI_USAGE` (exit code 2).
- `pidgen intent list [--project <ref>] [--state <state>]` — `data` is one array of the intake
  requests the caller may see, newest first, each as `intent show` returns it; the CLI follows
  every page as `pidgen ticket list` does. `--project` is sent as `project_id`, and `--state` as
  `state`: `clarifying` (waiting on answers), `created` (became a ticket) or `withdrawn`. Without
  `--state` the CLI sends none, and the server lists the `clarifying` requests. An unknown state
  (`creating` too, which the list does not take), an empty `--project`, a missing option value, or
  an argument is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen intent show <conversation>` — `data` is the request: `request_id` (its key, `REQ-{n}`), `project_id`,
  `title`, `text`, `source` and `source_location`, `submitted_by` and `submitted_at`, the Agent
  (`team_member_id`, and `agent_source`: `chosen`, `project_default` or `unassigned`), its `state`
  (`clarifying`, `creating`, `created` or `withdrawn`), its `questions` with `question_count`,
  `answered_count` and `assumption_count`, the ticket it became (`ticket_id`, `ticket_key`,
  `created_by`, else null), the `withdrawn` record (`by`, `at`, `reason`, else null),
  `decision_key`, `followup`, `version`, `addressed_to` — who it waits on, each with a `reason` of
  `submitter`, `asked` or `fallback` — `waiting_since`, and `actions`: what can be done with it
  (`answer_request`, `create_request_anyway`, `withdraw_request`, `snooze_reminders` or
  `defer_decision`), each with its `admissible` and `authorized` verdicts and its `recommended`
  reason, or null. Each question has its `question_id`, `text`, `recommendation` (`answer` and
  `consequence`, or null), `choices` (or null), whether it is `required`, its `answer` (`text`,
  `kind` of `answer` or `assumption`, `by` and `at`, or null), the teammates it was `asked` of and
  its `left_open` record (or null). An unknown or another Account's request exits 4 with the
  server's `CONVERSATION_NOT_FOUND`. A missing, empty, `.` or `..` conversation, or more than one,
  is `CLI_USAGE` (exit code 2).
- `pidgen intent withdraw <conversation> [--reason <text>]` — withdraws a request that is still
  waiting on answers and sends `{reason}` when `--reason` is given, else an empty body. `data` is
  the withdrawn request, with `state` `withdrawn` and `withdrawn` saying who withdrew it, when and
  why. Two refusals exit 5, as refusals rather than failures: `REQUEST_WITHDRAW_FORBIDDEN` (a 403:
  you may not withdraw this request) and `REQUEST_ALREADY_CREATED` (it already became a ticket;
  `error.details.ticket_id` and `error.details.ticket_key` name it). An unknown or another
  Account's request exits 4 with `CONVERSATION_NOT_FOUND`; a plain `FORBIDDEN` still exits 3. An
  empty `--reason`, a missing value, or a missing, empty, `.` or `..` conversation is `CLI_USAGE`
  (exit code 2) and sends nothing.

## request

A **Request** is work someone asks for: a `bug`, `feature`, `task` or `question`, with a title,
the requester's own text (`body`, never rewritten) and, for a bug, its `details` (steps, expected
and actual results, and the ones that are `unknown`). It is submitted through a source (a token
submits through the source it is bound to; a web session through the Account's `web` source) and
triaged: acknowledged, asked about, replied to, accepted, closed, or promoted to a Ticket. Its
state is `new`, `acknowledged`, `accepted`, `promoted`, `resolved` or `closed`. A Request is named
by its key in the Account, `REQ-{n}` (e.g. `REQ-12`), and its page is
`/requests/REQ-{n}?account=<account>` on the server. Every command prints the key in `id`, and the
Request's internal id only when the server has no key for it; every `<request>` argument (and
`--duplicate-of`) takes the key and is sent as given, and the server resolves it inside the
Account. Submitting needs `request.submit`; every
other write needs `request.triage`.

The routes are in the published document: every body is validated against it before it is sent
(`INPUT_INVALID`, exit 2) and every answer after (`UNEXPECTED_RESPONSE`, exit 1). The writes act
directly, with no preview ([Preview and apply](preview-and-apply.md)).

| Command | Does | Route |
|---|---|---|
| `pidgen request submit [-f <file>] [--kind <kind>] [--title <title>] [--body <text>] [--steps <text>] [--expected <text>] [--actual <text>] [--urgency <urgency>] [--target <kind>:<id>] [--fingerprint <text>] [--submission-key <key>] [--evidence <file>...]` | Submit a Request, with a bug's details and evidence files | `POST /requests`, then `POST /requests/{request_id}/attachments` per file |
| `pidgen request list [--state <state>] [--kind <kind>] [--target <kind>:<id>] [--source <id>] [--query <text>] [--page <n>] [--per-page <n>]` | List Requests | `GET /requests` |
| `pidgen request show <request>` | A Request, its requester and its timeline with attachments | `GET /requests/{request_id}`, `GET /requests/{request_id}/timeline` |
| `pidgen request reply <request> --text <text> [--ask]` | Reply to the requester, or ask them a question | `POST /requests/{request_id}/reply` or `/ask` |
| `pidgen request acknowledge <request>` | Tell the requester it was seen | `POST /requests/{request_id}/acknowledge` |
| `pidgen request accept <request> [--priority P1\|P2\|P3\|P4] [--unknown steps\|expected\|actual ...]` | Accept it as work to do | `POST /requests/{request_id}/accept` |
| `pidgen request close <request> --reason <reason> [--note <text>] [--duplicate-of <request>]` | Close it with a reason | `POST /requests/{request_id}/close` |
| `pidgen request promote <request> [--project <project>] [--workflow-type <type>] [--no-refine]` | Promote it to a Ticket in the Project it targets | `POST /requests/{request_id}/promote` |

- `pidgen request submit` — builds the body `{kind, title, body, details?, urgency?, target?,
  external_ref?, external_url?, requester?, fingerprint?, submission_key?}`. `-f` with a `.json`,
  `.yaml` or `.yml` file (or standard input starting with `{`) is that body, and the flags override
  it; any other file (e.g. `report.md`) is the `body` text. Give the body with `--body` or `-f`,
  not both. `--steps`, `--expected` and `--actual` are a bug's `details`. `--kind` is `bug`,
  `feature`, `task` or `question`; `--urgency` `low`, `normal`, `high` or `urgent`; `--target`
  `project:<id>` or `domain:<id>` (a bare id is a Project; without it the Request is aimed at the
  Account's domain). `--fingerprint` names the same problem across submissions, so a match is
  counted as an occurrence of the open Request, or a regression of a resolved one. Without
  `--submission-key` one is generated, so a retry after a network failure is the same submission.
  Each `--evidence` file is read before anything is sent (a missing one is `CLI_USAGE`, exit 2)
  and uploaded after, as multipart, to the returned `occurrence_id`, or else `entry_id`. `data` is
  `{outcome, url, request, entry_id, occurrence_id, attachments}`: `outcome` is `created`,
  `appended`, `occurrence` or `regression`, `url` the Request's page
  (`/requests/REQ-{n}?account=<account>`), `request.id` its key, and `attachments` each
  uploaded file's `{id, name, media_type, size}`. A refused upload (`FILE_TOO_LARGE`,
  `REQUEST_ATTACHMENT_TYPE_REFUSED`, `REQUEST_ATTACHMENTS_LIMIT`) keeps its code and exit, and its
  `error.details` name the Request already filed (`request`, `outcome`, `url`, `file`, `uploaded`).
- `pidgen request list` — `--state`, `--kind`, `--target`, `--source` and `--query` are sent as
  `state`, `kind`, `target_kind` and `target_id`, `source_id` and `q`. Without `--page` every page
  is followed to the last; with `--page` (and `--per-page`, 1–100) only that page is read. `data`
  is the list of Requests, newest first, each named by its key in `id`.
- `pidgen request show <request>` (e.g. `pidgen request show REQ-12`) — `data` is
  `{request, timeline}`. The Request is named by its key in `id`, a duplicate's original by its key
  in `duplicate_of`, and a promoted Request's Ticket by `promoted.ticket_key` (beside its `kind`,
  `id` and `stage`). It carries every field the server states: `state`, `waiting_on_requester`, `kind`, `title`, `body`, `details`, `urgency`,
  `priority`, `labels`, `target`, `source`, `external_ref`, `external_url`, `requester`,
  `fingerprint`, `occurrence_count`, `close_reason`, `close_note`, `duplicate_of`, `promoted`,
  `version`, `created_at` and `updated_at`; `urgency`, `target`, `source` and `requester` may be
  null. Its `requester` is `{name, contact}`, and `contact` is left out when the server withholds it
  (a caller without `request.triage`). Each timeline entry is
  `{id, kind, author, text, channel, attachments, files, created_at}`, `kind` being `requester`,
  `reply`, `note`, `system` or `occurrence`, oldest first: `author` is `{actor, name, contact}`,
  `attachments` the ids of the files attached to it, and `files` each one's
  `{id, name, media_type, size}`, in the same order.
- `reply`, `acknowledge`, `accept`, `close` and `promote` read the Request first
  (`GET /requests/{request_id}`) and send its `version` with the write, so a Request changed in
  between is refused with `REQUEST_VERSION_CONFLICT` rather than overwritten. `data` is the
  Request in its new state; `reply` answers `{state, request, entry_id}` and `promote`
  `{state, request, ticket_id, ticket_key}`, `state` being the Request's new state and `ticket_key`
  the new Ticket's key. `reply --ask` asks a
  question, after which the Request waits on the requester (`waiting_on_requester`).
  `accept --unknown` names a bug's details accepted as unknown. `close` requires `--reason`, one of
  `cannot_reproduce`, `wont_do`, `duplicate`, `invalid`, `answered`, `no_response`, `withdrawn` and
  `other`; `duplicate` requires `--duplicate-of` and `other` requires `--note`, checked before
  anything is sent (`CLI_USAGE`, exit 2). `promote` makes an accepted Request a Ticket in the
  Project it targets; `--project` confirms that Project, and another, or a Request that targets a
  Domain or nothing, is refused with `REQUEST_TARGET_NEEDS_PROJECT`. It carries every attachment to
  the Ticket and starts refinement unless `--no-refine`; a retry answers the same Ticket.

The Request refusals print the CLI's own sentence in `error.message` (the server's message is kept
in `error.details.server_message`) and exit with the same code whatever the HTTP status:

| `error.code` | Exit | Sentence |
|---|---|---|
| `REQUEST_NOT_FOUND` | 4 | No such request in this Account, or one you may not see. |
| `REQUEST_VERSION_CONFLICT` | 5 | The request changed since it was read; show it again and retry. |
| `REQUEST_TRANSITION_REFUSED` | 5 | The request's state does not allow that; a promoted request no longer changes. |
| `REQUEST_RATE_LIMITED` | 5 | Too many requests came through this source; wait and submit again. |
| `REQUEST_SOURCE_PAUSED` | 5 | The source this credential submits through is paused; nothing was filed. |
| `REQUEST_BUG_DETAILS_REQUIRED` | 5 | A bug is accepted only with its steps, expected and actual results; name the missing ones with --unknown. |
| `REQUEST_TARGET_NEEDS_PROJECT` | 5 | The request does not target that Project, or targets a Domain or nothing; move it to a Project first. |
| `REQUEST_REPLIES_OFF` | 5 | The request's source does not carry replies to the requester; add a note instead. |

## session

| Command | Does | Route |
|---|---|---|
| `pidgen session steer <session> (--text <text> \| -f <file>) [--queue] [--attach <artifact>]… [--quote-message <id>]… [--quote-file <path>:<start>-<end>@<snapshot>]…` | Give an agent session an instruction, delivered live to the running session or to the step's next attempt, with its mode, attachments and quotes | `POST /sessions/{session_id}/instructions` |
| `pidgen session instructions <session>` | List a session's instructions | `GET /sessions/{session_id}/instructions` |
| `pidgen session edit-instruction <session> <instruction> (--text <text> \| -f <file>)` | Change the text of an instruction that has not been delivered | `GET /sessions/{session_id}/instructions`, `PATCH /sessions/{session_id}/instructions/{instruction_id}` |
| `pidgen session withdraw-instruction <session> <instruction>` | Withdraw an instruction that has not been delivered | `POST /sessions/{session_id}/instructions/{instruction_id}/withdraw` |

Steering an instruction is giving one agent session something to act on, with a receipt. The
instruction is **queued** for that session, then reaches the agent one of two ways:

- **Live.** While the step's attempt is running on a worker that supports live delivery, the
  instruction is **dispatched** to that running session and **accepted** into the agent's running
  conversation, then **acknowledged** when that attempt settles. `consumed_at` is set when the
  provider shows the agent read it.
- **Next attempt.** Otherwise, or when the running session cannot take it, it is **delivered** once
  to that step's next prompt (the session's next turn or, if the session ended, the step's next
  attempt), and then **acknowledged**. An instruction a running session returned is `queued` again
  with a `return_code` saying why (for example `HARNESS_UNSUPPORTED` or `ATTEMPT_SETTLING`): the
  running session did not receive it.

It is reported **unapplied** when the step never runs again. Only a queued instruction can be
edited or withdrawn. `acknowledged` means the agent received the instruction; it does **not** mean
the instruction was implemented. Read the work itself to see what the agent did. Each instruction
has a **mode**: `steer` reaches the agent at its next safe point, after the current tool calls;
`queue` reaches it when it would otherwise finish its current work. `pidgen session steer` sends
`queue` with `--queue`, and otherwise leaves the mode to the server's default, `steer`. The state
`queued` is not the mode `queue`.

`<session>` is the agent session's id and the Account comes from the credential.
In JSON mode, each command prints one envelope, and `data` is the server's instruction (or array of
instructions) unchanged. Terminal stdout defaults to human-readable output.

An **instruction** has:

- `instruction_id`, `kind` (`steer`, or `request_changes`, an instruction made by requesting
  changes rather than by steering; the CLI creates only steers), `ticket_id`, and the step it
  targets: `target_run_id`, `target_node_id`, `target_fan_out_key`,
  `target_session_id` and `target_label` (each null when the target does not name one);
- `author`, a person: `kind` (`user`, `agent` or `system`), `user_id` (null for an Agent or the
  system) and `display_name`;
- `text`, `items` (each `item_id` and `text`) and `artifact_refs`, the artifacts pinned to it: each
  `artifact_id`, `name`, `media_type`, `size_bytes`, the `version` pinned, its `author` and whether
  it is still `available`; `source_message_ids`, `presented_message_ids`, `reviewed_revision` and
  `request_key`;
- `state`: `queued` (not yet given to the agent), `dispatched` (sent to the step's running
  session), `accepted` (in the agent's running conversation), `delivered` (a prompt carried it, in
  `delivered_session_id`), `acknowledged`, `unapplied` (the step never ran again; `unapplied_reason`
  is `step_not_run_again`) or `withdrawn`, with `queued_at`, `dispatched_at`, `accepted_at`,
  `delivered_at`, `acknowledged_at`, `unapplied_at` and `withdrawn_at`, each null until it happens;
- the live path's evidence: `consumed_at` (when the provider showed the agent read it; not every
  provider shows it), `provider_message_ref` (the provider's identifier for the input, where it
  returns one) and `return_code` (why it last returned from a running session to `queued`; null if
  it never did);
- `mode`, `steer` or `queue`, and `deadline_seconds`, reserved and null in this release;
- `quoted_event_refs` (each `session_id`, `event_id` and `digest`) and `quoted_file_refs` (each
  `path`, `side`, `start_line`, `end_line`, `source`, `snapshot_commit_sha`, `turn_id`,
  `captured_at` and `digest`): what the author quoted, as provenance only;
- `editable`, whether it can still be edited or withdrawn, and `version`, which changes whenever the
  instruction does.

- `pidgen session steer <session> (--text <text> | -f <file>)` — gives the session the text as an
  instruction and prints it in the state the server reports (`queued`, or `dispatched` when the
  server sent it straight to the running session), with its `mode`. The help (`--help`) describes
  live delivery and each state. Give the text with `--text`, or with `-f <file>` (`-f -` reads
  standard input), exactly one of them: it is plain text, not a JSON or YAML body, and surrounding
  whitespace, such as a file's final newline, is removed. It must be 1–8000 characters. The
  command sends one generated `idempotency_key` with the text, and sends it again unchanged if a
  response is lost, so a retried command does not queue the instruction twice; running the command
  again by hand queues another. The server refuses with a `409` — `STEP_SETTLED` (the step already
  finished), `RUN_PAUSED`, `RUN_HELD`, `RUN_TERMINAL` (the run has ended) or
  `STEER_TARGET_NOT_PROMPT` (the step takes no prompt) — and each is a refusal, exit code 5. An
  unknown session exits 4 with `SESSION_NOT_FOUND`. `STEER_EMPTY`, `STEER_TOO_LONG` and
  `ARTIFACT_REFERENCE_UNAVAILABLE` and `MODE_UNSUPPORTED` (a `422`) exit 2, and a `403` exits 3.
  Giving both `--text` and `-f`, or neither, empty text, text over 8000 characters, an unreadable
  file (`INPUT_INVALID`), a missing, empty, `.` or `..` session, or an extra argument is a usage
  error (exit code 2) and sends nothing.

  The composer's flags are each sent only when given, and each repeatable flag keeps the order
  given:

  - `--queue` sends `mode: queue`: the agent gets the instruction when it would otherwise finish.
  - `--attach <artifact>` (repeatable) pins an existing artifact by id, sent as `artifact_refs`.
  - *Planned:* `--upload <file>`, staging a local file and pinning it (the request's `upload_ids`).
    It waits for the public API to publish an upload route
    ([API compatibility](api-compatibility.md#not-yet-published)).
  - `--quote-message <id>` (repeatable) records a conversation message the text quotes, sent as
    `source_message_ids`.
  - `--quote-file <path>:<start>-<end>@<snapshot>` (repeatable) records lines `start` to `end` of
    `path`, from the new side of the snapshot commit `snapshot` (7 to 64 hexadecimal characters),
    sent as a `quoted_file_refs` entry with `source: snapshot`. The CLI reads `path` from the
    working directory, which should hold that snapshot, and sends the `sha256:` digest of the
    quoted lines (joined with a newline, without a final one).

  The quotes are provenance only: the text is the instruction, so put the quoted words in it. At
  most 10 artifacts in all. Every flag is checked and every file read before anything is sent: an
  empty `--attach` or `--quote-message`, more than 10 attachments, a `--quote-file` file that
  cannot be read (`INPUT_INVALID`), or a
  `--quote-file` that is not in that form, counts from line 0, ends before it starts, ends past the
  file's last line or names a snapshot that is not a commit is a usage error (exit code 2).
- `pidgen session instructions <session>` — lists the instructions steered to the session, newest
  first, in every state, as one array. An unknown session exits 4 with `SESSION_NOT_FOUND`. A
  missing, empty, `.` or `..` session, or an extra argument, is `CLI_USAGE` (exit code 2).
- `pidgen session edit-instruction <session> <instruction> (--text <text> | -f <file>)` — changes
  an instruction's text and prints the edited instruction. The text is given as for `steer`. The
  CLI first reads the session's instructions (the list route) and sends the named instruction's
  current `version` with the new text, so the edit is made to the instruction you saw; an
  instruction the session does not list exits 4 with the CLI's own `INSTRUCTION_NOT_FOUND`, and
  nothing is changed. Whether the instruction can still be edited is the server's decision, so
  the CLI sends the change even when the list shows it delivered. `INSTRUCTION_ALREADY_DELIVERED`
  (a prompt already carried it) and `INSTRUCTION_VERSION_STALE` (it changed after the read) are
  `409` refusals, exit code 5. `INSTRUCTION_NOT_AUTHOR` is a `403`: only the author may edit, and
  like every `403` it exits 3. Usage errors are as for `steer`, plus a missing instruction.
- `pidgen session withdraw-instruction <session> <instruction>` — withdraws the instruction and
  prints it, with `state` `withdrawn`. The request has no body and is not retried after a lost
  response, because a second attempt would be answered as a refusal. `INSTRUCTION_ALREADY_DELIVERED`
  is a refusal (exit code 5), `INSTRUCTION_NOT_AUTHOR` exits 3, and an unknown session or
  instruction is the server's `404` (exit code 4). A missing, empty, `.` or `..` session or
  instruction, or an extra argument, is `CLI_USAGE` (exit code 2) and sends nothing.

## epic

An Epic is a ticket of kind `epic`. It is filed, listed, read and edited with the ticket commands
and `--kind epic`, a ticket sits in it through its `parent_ticket_id`, and edges between Epics and
tickets are ordinary dependencies. The `pidgen epic` commands are aliases onto those ticket
commands, with the flags they always had, so existing scripts keep working:

| Command | Alias of | Route |
|---|---|---|
| `pidgen epic list [--project]` | `pidgen ticket list --kind epic [--project]` | `GET /tickets?kind=epic` |
| `pidgen epic show <key>` | `pidgen ticket show <key> --kind epic` | `GET /tickets/{key}`, `GET /tickets/{key}/prerequisites` |
| `pidgen epic create -f <file> [--domain <domain>]` | `pidgen ticket create --kind epic -f <file> [--domain <domain>]` | `POST /tickets` |
| `pidgen epic edit <key> -f <file>` | `pidgen ticket edit <key> --kind epic -f <file>` | `GET /tickets/{key}`, `PATCH /tickets/{key}` |
| `pidgen epic dag show <key>` | — (the Epic's dependency graph) | `GET /tickets/{key}/dependencies/graph` |
| `pidgen epic edge add <key> --from <ref> --to <ref> [--type]` | `pidgen ticket dep add <--to> --on <--from> [--type]` | `POST /tickets/{--to}/dependencies` |
| `pidgen epic edge rm <key> --from <ref> --to <ref> [--type]` | `pidgen ticket dep rm <--to> --on <--from> [--type]` | `DELETE /tickets/{--to}/dependencies/{--from}` |

`{key}` is the Epic's ticket key, such as `PIDGEN-40`, or its id (`TKT-…`). Each alias behaves, and
answers, exactly as the command it stands for (see [ticket](#ticket)); a server refusal keeps its
own `error.code` and exits with the code for its status
([Output and exit codes](output-and-exit-codes.md)).

- `pidgen epic list [--project <id>]` — `data` is every Epic you can see, every page followed.
  `--project` is sent as `project_id`. An empty `--project`, or an argument, is `CLI_USAGE` (exit
  code 2) and sends nothing.
- `pidgen epic show <key>` — `data` is the Epic with its `prerequisites`. A ticket that is not an
  Epic is `TICKET_KIND_MISMATCH` and an unknown one the server's `TICKET_NOT_FOUND`; both exit 4.
- `pidgen epic create -f <file>` — the file is a ticket create body, sent with `kind: epic` (see
  `pidgen ticket create`). The retired epic fields `priority_weight`, `target_completion` and
  `create_feature_branch` are not part of it: a file naming them exits 2 with `INPUT_INVALID`; use
  `priority`, `target_date` and `branch_mode`. `--domain <domain>` files a
  [Domain Epic](#domain-epics), as `pidgen ticket create --domain` does.
- `pidgen epic edit <key> -f <file>` — the file is a ticket edit body (see `pidgen ticket edit`):
  `title`, `objective`, `priority`, `merge_policy` and the other content fields. A ticket that is
  not an Epic is `TICKET_KIND_MISMATCH` (exit 4) and nothing is changed.
- `pidgen epic dag show <key>` — `data` is the server's graph centred on the Epic unchanged: its
  `ticket_id` and `ticket_key`; the tickets it waits for and that wait for it as `nodes` (each with
  `id`, `ticket_key`, `title`, `stage`, `status_label`, `situation`, `depth` and
  `on_critical_path`) and the `blocks` `edges` between them; and its members as `pieces` with the
  `piece_edges` between them. An unknown ticket exits 4 with `TICKET_NOT_FOUND`. A missing, empty,
  `.` or `..` key, or more than one, is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen epic edge add <key> --from <ref> --to <ref> [--type <type>]` — declares that `--to`
  depends on `--from`, either of which may be an Epic or a ticket of the same project. `<key>`
  names the Epic for the caller and is not sent. The refusals and usage errors are those of
  `pidgen ticket dep add`; a missing, empty, `.` or `..` `<key>`, `--from` or `--to` is
  `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen epic edge rm <key> --from <ref> --to <ref> [--type <type>]` — removes that edge, as
  `pidgen ticket dep rm` does.

## plan

Child plans: a root ticket and the children that share its workspace.

| Command | Does | Route |
|---|---|---|
| `pidgen plan show <root>` | The current child plan, its version and digest | `GET /tickets/{ref}/child-plan` |
| `pidgen plan apply <root> -f <plan>` | Preview/apply a complete child plan and its dependencies | `POST /tickets/{ref}/child-plan/preview`, `PUT /tickets/{ref}/child-plan` |
| `pidgen plan promote <root>` | Preview/apply promotion; the preview lists failing gates | `POST /tickets/{ref}/promotion/preview`, `POST /tickets/{ref}/promotion` |
| `pidgen plan template` | Write an annotated plan file to fill in | — |
| `pidgen plan cohorts -f <slices> [--max-children <n>]` | Group planned slices into delivery cohorts by the files they edit; local, sends nothing | — |

### plan show

```console
$ pidgen plan show PIDGEN-12
```

- Reads `GET /tickets/{ref}/child-plan` for the high-level ticket `<root>`.
- `data` is the server's child plan: `root_ticket_id`, `ticket_version` (the root's version),
  `materialized_plan_digest` (the current plan's digest, `null` before any plan was applied),
  `items` (each current child with its `plan_item_id`), `dependencies` between them by
  `plan_item_id`, and `validation_findings`. A response without `ticket_version` and
  `materialized_plan_digest` is `UNEXPECTED_RESPONSE` (exit code 1).
- A ticket with a parent is refused with `HIGH_LEVEL_TICKET_REQUIRED` (exit code 5); an unknown
  ticket is `TICKET_NOT_FOUND` (exit code 4).

### plan apply

```console
$ pidgen plan apply PIDGEN-12 -f child-plan.yaml
$ pidgen plan apply PIDGEN-12 -f child-plan.yaml --apply --digest sha256:9f… [--ack supersedes-children]
```

- `-f <plan>` is required; without it the command exits 2 (`CLI_USAGE`) and sends nothing. The file
  ([Input files](#input-files)) is the complete plan — `children`, `dependencies` and `summary`, as
  `pidgen plan template` writes it — and is validated against the child-plan schema before anything is
  sent; issue paths are relative to the file (`$.children[0].objective`).
- Follows [Preview and apply](preview-and-apply.md) with the shared flags. Without `--apply` it
  previews with `POST /tickets/{ref}/child-plan/preview` and changes nothing; `data` is the preview:
  `plan`, `preview_digest`, `required_acknowledgements`, the `ticket_version` and
  `materialized_plan_digest` it read, and its `effects` (`created`, `retained`, `superseded`).
- A child may select its Agent with `team_member_id`, an Account Agent ID (not a model name) of 1
  to 80 characters; `null` or another type exits 2 with `INPUT_INVALID` before anything is sent.
  Omitted, a kept child keeps its Agent and a new child takes the Project default, else the
  Account's reserved Unassigned Agent. Eligibility is the server's: an ID that is no Agent of the
  Account is `TEAM_MEMBER_NOT_FOUND` (exit 4), and a kept child that has already started keeps its
  Agent, so selecting another is `PLAN_ITEM_AGENT_FIXED` (exit 5).
- Each child may carry starting briefs — the files to change, the pattern to copy, the contract
  rows and the narrowest test — in one of two forms, never both (see [Child briefs](#child-briefs)
  below). Both are checked, and a problem exits 2 with `INPUT_INVALID` before anything is sent.
- With `--apply` it sends the same plan with `PUT /tickets/{ref}/child-plan`, together with the
  preview's digest, which binds the version and plan digest the preview read, so a plan or ticket
  changed since is refused with `PREVIEW_STALE` (exit code 6). Leaving out a current child
  supersedes it, which the preview lists as the `supersedes_children` acknowledgement.
- `data` after an apply: `settled`, `result` (the server's result: `status`, `items`,
  `superseded_ticket_ids`, the new `materialized_plan_digest`), `idempotency_key`, and, when not
  settled with `--no-wait`, `handle` (the status route).
- A refused plan exits 5 with the server's code, for example `PLAN_ALREADY_ADMITTED`,
  `BACKLOG_STAGE_REQUIRED` or `SUBJECT_EXECUTION_READINESS_FAILED` — also when the server answers
  the refusal with `200`: its `disposition_code` becomes `error.code`, and `error.details` carries
  the `disposition_code`, any `disposition_detail`, and the server's `result`.

#### Child briefs

A child's objective says what it delivers; a brief gives it a starting point at filing time, so the
planner does not edit objectives afterwards. A child carries at most one of these two fields in the
plan file (JSON or YAML):

| Field | Meaning |
|---|---|
| `context_artifacts` | A list of at most 3 briefs, each `{type: brief, tier: stage, content, reference_url?}`: `type` is `brief`, `tier` is `stage`, `content` has 1 to 8192 characters, and `reference_url` is an optional string. Sent unchanged, in the preview and in the apply. |
| `brief_file` | A path to a text file, relative to the directory of the plan file (to the working directory when the plan is read from standard input; an absolute path is used as it is). The CLI reads it and sends its text, as written, as one `{type: brief, tier: stage, content}` item in `context_artifacts`; `brief_file` itself is not sent. |

```yaml
children:
  - key: first
    title: First slice
    objective: Deliver the first observable behavior.
    workflow_type: implementation
    brief_file: briefs/first.md          # read relative to this plan file
  - plan_item_id: ITEM-EXAMPLE-KEPT
    title: Follow-up slice
    objective: Extend the first behavior.
    workflow_type: implementation
    context_artifacts:
      - type: brief
        tier: stage
        content: "Files to change: src/follow-up.ts. Narrowest test: tests/follow-up.test.ts."
```

- Omitting both means the child has no brief. For a child kept with `plan_item_id`, the stored
  briefs are replaced only when the child names `context_artifacts` or `brief_file`; a child that
  names neither keeps what it has.
- A `brief_file` that is missing or unreadable, is not a file, is empty, or has more than 8192
  characters (counted as characters, not bytes), a `brief_file` that is not a non-empty string, and a
  child naming both `brief_file` and `context_artifacts` are usage errors: exit 2, `INPUT_INVALID`,
  with `error.details.issues` locating each at `$.children[<n>].brief_file`. A `context_artifacts`
  that is not a list of at most 3 briefs of type `brief` and tier `stage` with 1 to 8192 characters
  of content is refused the same way, at `$.children[<n>].context_artifacts`. Every problem in the
  file is listed together, and no request is sent.
- The App Service publishes this contract (see
  [API compatibility](api-compatibility.md#the-public-api)).

Agent assignment eligibility and active-run effects are a **server contract**. The server owns
authorization, same-Account membership, archived-Agent eligibility and any effect on accepted or
active execution. The CLI validates only the ID's shape on ticket creation, the one published
place an Agent is selected, permits reserved Unassigned IDs, and returns public server results and
refusals. HTTP 403 exits 3, 404 exits 4, 409 exits 5; `PREVIEW_STALE` exits 6. Other statuses
follow [Output and exit codes](output-and-exit-codes.md).

### plan promote

```console
$ pidgen plan promote PIDGEN-12
$ pidgen plan promote PIDGEN-12 --apply --digest sha256:9f… [--reason "Start the cohort"]
```

- Follows [Preview and apply](preview-and-apply.md) with the shared flags. Without `--apply` it
  previews with `POST /tickets/{ref}/promotion/preview` and changes nothing; `data` is the preview:
  `plan` (the root, its `ticket_version`, the `covered_children` promotion releases with the root,
  the `dependencies` touching them, the `materialized_plan_digest` and `releases_count`),
  `preview_digest`, `required_acknowledgements`, `passed`, every gate in `gate_results`, and each
  failing gate in `failing_gates` — its `gate` (for example `materialized_plan_current` or
  `ticket:{id}:execution_readiness`), `reason` and `repair_target`, the ticket to repair. Failing
  gates are part of the preview, not a refusal: the preview exits 0. On a terminal, standard error
  also lists the failing gates. A preview without `passed`, `gate_results` and `failing_gates` is
  `UNEXPECTED_RESPONSE` (exit code 1).
- With `--apply --digest <d>` it sends that digest with `POST /tickets/{ref}/promotion`; the server
  admits the ticket and its cohort only when every gate passed and nothing changed since the
  preview. A `202` is followed on its `status_url` until it settles (`--no-wait` returns at once).
- `--apply` without `--digest` previews first; when that preview has a failing gate it applies
  nothing and exits 5 with `PROMOTION_GATE_FAILED`, `error.details.failing_gates` listing the
  gates to repair.
- `data` after an apply: `settled`, `result` (the server's result: `status`, `command_id`,
  `root_ticket_id`, the new `ticket_version`, `execution_admission_digest`,
  `materialized_plan_digest`, `releases_count` and `covered_ticket_ids`), `idempotency_key`, and,
  when not settled with `--no-wait`, `handle` (the status route).
- A refused promotion exits 5 with the server's code: `PROMOTION_GATE_FAILED` (a gate failed since
  the preview; `error.details.gate_results`), `ACCOUNT_NOT_ACTIVE`, `HIGH_LEVEL_TICKET_REQUIRED`,
  `BACKLOG_STAGE_REQUIRED`, `TICKET_PROJECT_REQUIRED`, `PROMOTION_PREVIEW_LIMIT_EXCEEDED` or
  `COMMAND_IDEMPOTENCY_CONFLICT`. A promotion changed since the preview is `PREVIEW_STALE` (exit
  code 6); an unknown ticket is `TICKET_NOT_FOUND` (exit code 4).
- Without `<root>`, or with `--digest` but no `--apply`, it exits 2 (`CLI_USAGE`) and sends nothing.

### plan template

```console
$ pidgen plan template [-o child-plan.yaml] [--force]
```

- Writes an annotated child plan to `-o <file>` (default `child-plan.yaml` in the current
  directory) and sends nothing. The placeholders are valid, so the file as written is a plan
  `pidgen plan apply` accepts; replace them first. A `.json` output gets the same plan as JSON,
  without the comments.
- Each child's acceptance criteria need only a `statement`; the template shows an optional
  `assertion` on one and leaves `test_assertion` (a pinned check) to a comment.
- A comment shows both forms of a child's brief, `context_artifacts` and `brief_file`, without
  setting either: the file as written has no `brief_file`, which would need a file beside it. See
  [Child briefs](#child-briefs).
- Comments describe a child's optional `team_member_id` without setting it; the ticket template
  shows the optional `team_member_id` at creation and the automatic edit-version handling.
- An existing file is not overwritten: `FILE_EXISTS` (exit code 5) unless `--force`.
- `data`: `path` and `format` (`yaml` or `json`).

### plan cohorts

`pidgen plan cohorts` reads a YAML or JSON slice list — each slice's `id`, the existing `files` it
will edit, the slices it `needs`, and optionally its `cohort` — and proposes delivery cohorts, or
checks the ones you gave. It prints the cohorts, the root-to-root edges they need, the number of
pull requests and the longest chain, and sends nothing to the server. See
[Planning work in cohorts](planning-cohorts.md).

## manifest

Ticket manifests: a new high-level ticket, its children, the edges among them and where they are
filed, previewed with every finding at once and committed in one transaction, optionally promoting
it. The routes are published by the server
([API compatibility](api-compatibility.md#the-public-api)).

| Command | Does | Route |
|---|---|---|
| `pidgen manifest template [-o <file>] [--children <n>]` | Write an annotated manifest to fill in; local, sends nothing | — |
| `pidgen manifest apply -f <manifest>` | Preview, then with `--apply` commit, a whole manifest | `POST /ticket-manifests/preview`, `POST /ticket-manifests` |

### manifest template

```console
$ pidgen manifest template [-o ticket-manifest.yaml] [--children 2] [--force]
```

- Writes an annotated manifest to `-o <file>` (default `ticket-manifest.yaml` in the current
  directory) and sends nothing. The placeholders are valid, so the file as written is a manifest
  `pidgen manifest apply` accepts; replace them first. A `.json` output gets the same manifest as
  JSON, without the comments.
- Every field has a comment, and each content field says the readiness points it earns: a ticket
  runs only with 60 of 100 points and an `estimated_complexity`. Criteria earn 10 points each (at
  most 30) and MUST criteria 5 more (at most 20); `scope_boundaries` 10; at least one success
  metric 10; context artifacts 5 each (at most 15); each open question costs 5; a child, which
  lands at `implementation_ready`, earns 15 more.
- `--children <n>` writes `n` children (0 to 50, default 2), `child-1` to `child-n`, chained by
  `blocks` edges. Anything else is `CLI_USAGE` (exit code 2) and writes nothing.
- An existing file is not overwritten: `FILE_EXISTS` (exit code 5) unless `--force`.
- `data`: `path`, `format` (`yaml` or `json`) and `children`.

### manifest apply

```console
$ pidgen manifest apply -f ticket-manifest.yaml
$ pidgen manifest apply -f ticket-manifest.yaml --apply [--digest sha256:9f…] [--idempotency-key <k>] [--reason "…"] [--no-wait]
```

- `-f <manifest>` is required ([Input files](#input-files)); the file is the manifest, checked
  against the manifest schema before anything is sent. An invalid file exits 2 with
  `INPUT_INVALID`, every issue located in the file (`$.children[0].ref`), and sends nothing.
- Without `--apply` it previews with `POST /ticket-manifests/preview` and changes nothing. `data`:
  `committable`, `promotable`, `preview_digest`, `required_acknowledgements`, `finding_count`,
  `findings` grouped by ref — `manifest` for the manifest as a whole, then the root's ref, then
  each child's, in manifest order; a criterion's finding is under its ticket — and the server's
  resolved `plan`. A committable preview exits 0, whatever advisory or promotion findings it has.
- A preview that is not committable exits 5 with `MANIFEST_NOT_COMMITTABLE`, also with `--apply`,
  and no commit is sent. `error.details` carries the same report, and `blocking` lists the codes
  that block the commit. Fix every finding the preview reports, then preview again.
- With `--apply` it previews, then commits the same manifest with `POST /ticket-manifests`,
  sending the preview's digest (or `--digest`), an idempotency key (`--idempotency-key`, or one
  derived from the command, the Project and root ref, the digest and the acknowledgements, so a
  repeated commit is safe), the `--ack` codes and `--reason`. A `202` is followed on its
  `status_url` until it settles (`--no-wait` returns at once with `handle`).
- `data` after a commit: `settled`, `preview_digest`, `idempotency_key`, `tickets` (each ref's
  ticket key, the root first), `promoted`, the server's `result`, and `handle` when unsettled.
- A manifest that changed since the preview is `PREVIEW_STALE` (exit code 6). Other refusals exit 5
  with the server's code, e.g. `MANIFEST_NOT_COMMITTABLE`, `PROMOTION_GATE_FAILED` or
  `MANIFEST_IDEMPOTENCY_CONFLICT`; an unknown Project is `PROJECT_NOT_FOUND` (exit code 4).
- `--digest` without `--apply` is `CLI_USAGE` (exit code 2) and sends nothing.
- `promote: true` in the manifest is an explicit promotion: commit it only when the person asked
  for the work to run.

## review

| Command | Does | Route |
|---|---|---|
| `pidgen review list [--type clarification_needed]` | Tickets waiting on a person | `GET /tickets?intervention=…` |
| `pidgen review attention [--addressee me\|claimable\|following\|on_hold\|all]` | Open findings that need a person's decision — those with a recommended action first, then the oldest — each with its target, its action decisions and its recommended action, and the intake `requests` waiting on a person; `on_hold` lists the holds due for review | `GET /attention` |

`pidgen review list` and `pidgen review attention` are available read commands. A server refusal keeps
its own `error.code` and exits with the code for its status ([Output and exit
codes](output-and-exit-codes.md)).

- `pidgen review list [--type <type>]` — `data` is one array of every ticket with an open
  intervention of the type, newest first, each as `pidgen ticket list` returns it; the CLI follows
  every page as `pidgen ticket list --intervention <type>` does. `--type` defaults to
  `clarification_needed`, the tickets to answer with `pidgen ticket clarify`, and accepts
  `review_required`, `execution_failed`, `child_blocked`, `delivery_blocked`,
  `delivery_closed_unmerged` and `delivery_auto_merge_failed` too. An unknown type, a `--type`
  without a value, or an argument is `CLI_USAGE` (exit code 2) and sends nothing.
- `pidgen review attention` — `data` is the server's queue: `findings` in the server's order —
  those with a recommended action first, then the oldest — each with its ticket (`ticket_id`,
  `ticket_key`, `title`, `stage`, `project_id`, `parent_ticket_id`), what is wrong (`code`,
  `severity`, `detail`, and the `run_id`, `node_id`, `fan_out_key`, `session_id` and
  `prerequisite_id` concerned), when it was `first_detected_at` and `last_seen_at`, its `target`
  (the step, run, dependency or Ticket the decision is about, shaped as an action's `target`, or
  null) and `label`, and the server's further facts: `cause_code`, `effect_safety`,
  `recovery_reason`, `workflow_attention`, `review_item`, `related_records`, `delivery_count`,
  `revision`, `hold_state`, `hold_until`, `question`, `command_id`, `live_run_hold`, `decision_key`,
  an `addressee` (`kind`: `owner`, `fallback`, `worker_owner`, `delegate` or `reviewer`, and
  nullable `user_id`) and a nullable `claim`. A finding has no `action` field: what can be done is in its `actions`, its
  action decisions (as `pidgen ticket actions` lists them), unchanged. The CLI adds
  `recommended_action`: the recommended decision's `action`, `label`, `reason`, `target`, `state`
  (`allowed` or `blocked`) and blocking `refusal` (else null), or null when the finding recommends
  none — take it with `pidgen ticket act`. Then `open_count`, `ticket_count` and `swept_at`, when the
  audit sweep last ran: an empty queue is clean only since then; `addressee`, `counts` for `me`,
  `claimable`, `following`, `on_hold` and `all`; and `following` tickets (empty unless the filter is
  `following`), each with `ticket_id`, `ticket_key`, `title`, `project_id`, `stage`, `situation`,
  nullable `waiting_on` (`user_id`, `display_name`) and `source` (`explicit`, `owner` or
  `administrator`). `--addressee me|claimable|following|on_hold|all` passes that filter to the
  server; without it the CLI sends no filter (the server defaults to `all`). `on_hold` lists the
  holds due for review in your review scope; the queue's
  `review_scope` (`kind` `account` or `projects`, with `project_ids`, or null) says what that scope
  is, and `counts` gains `on_hold`. Each finding carries `followup` — where its decision stands in
  reminders, escalation and holds — and `hold`, the hold concerning it, or null. A decision due for
  review offers the follow-up actions, for example `keep_holding`, in its `actions`. The CLI
  preserves every field the server returns. A server that publishes durable intake requests adds
  `requests` — the intake requests waiting on a person, each `{decision_key, request}` with the
  request as `pidgen intent show` returns it — and `request_counts` (`me`, the requests waiting on
  you, `all`, and `items`, the request items that need you); the CLI prints both exactly as the
  server returns them, as it does the queue's `request_items` and `contract_refusals`, adds nothing to them,
  and sends no new option. Against a server that does not publish them the queue has neither field
  and is printed as before. An unknown addressee, missing option value, argument or unknown flag is
  `CLI_USAGE` (exit code 2) and sends nothing.

## run

| Command | Does | Route |
|---|---|---|
| `pidgen run list <ref>` | Workflow runs of a ticket, newest first | `GET /tickets/{ref}/runs` |
| `pidgen run show <run>` | One run, its nodes, terminal reason and stranded state | `GET /runs/{run_id}` |
| `pidgen run node-output <run> <node>` | One node's output | `GET /runs/{run_id}/nodes/{node_id}` |

`<run>` is a run's id (`WFR-…`) as `pidgen run list` reports it in `workflow_run_id`; `<node>` is a
node's id in the workflow, such as `implement`. `pidgen run list`, `pidgen run show` and
`pidgen run node-output` are available. A server refusal keeps its own `error.code` and exits with the
code for its status ([Output and exit codes](output-and-exit-codes.md)).

- `pidgen run list <ref>` — `data` is the server's array of the ticket's workflow runs, newest first
  (highest `attempt_number`, ties by the latest start), in the server's order. Each run has its
  `workflow_run_id`, `logical_run_id`, `attempt_number`, `workflow_name`, `status`, `started_at`,
  `ended_at`, `terminal_reason_code` (why it ended; `null` while it runs), `liveness` (`state` —
  `live`, `suspected`, `repairing` or `stranded` — with `recovery_count`, `recovery_limit` and
  `cause`), `parent_attempt_id`, `pass_count` and `admission_block_reason`. A ticket with no runs
  is an empty array. The route is not paged, so the array is the whole list. An unknown ticket, or
  another Account's, exits 4 with the server's `TICKET_NOT_FOUND`.
- `pidgen run show <run>` — `data` is that one run: the same fields, `stranded_cause` (the cause the
  runtime recorded when it last found the run making no progress, or `null`) and `nodes`, one entry
  per node that has an attempt with its `status`, `attempt_count`, `latest_attempt`, `started_at`
  and `ended_at`. An unknown run, or another Account's, exits 4 with the server's `RUN_NOT_FOUND`.
- `pidgen run node-output <run> <node>` — `data` is that node of the run: `status`, `attempts` (every
  attempt oldest first, each with its own `output` or `error`) and `output`, the latest attempt's
  `value`, `artifacts`, `evidence` and `output_digest`, or `null` until the node produces one. An
  unknown run exits 4 with `RUN_NOT_FOUND`, and a node with no attempt in the run exits 4 with
  `NODE_NOT_FOUND`.
- A missing, empty, `.` or `..` ref, run or node, or an extra argument, is `CLI_USAGE` (exit code 2)
  and sends nothing; `pidgen run node-output` needs both `<run>` and `<node>`.

## worker

See [Workers](workers.md).

| Command | Does |
|---|---|
| `pidgen worker install [--runtime wheel\|container] [--version <version>] [--force] [--test]` | Read the series to install from the server's worker release list with no credential (`GET /workers/releases`), take that series' newest release and this machine's wheel from PyPI (TestPyPI with `--test`), verify the wheel's PEP 740 attestation (or the image's cosign signature over the digest its tag names) against the worker's release identity, then install it with `uv tool install --python 3.12 --python-preference only-managed` into its own tool environment under the worker home (`UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`), never uv's shared tool slot, or pull `<repository>@<digest>`, and write the install record |
| `pidgen worker update [--version <version>] [--restart] [--test]` | Install `--version`, or the server's `current` series' newest release on the installed version's track (final releases; pre-releases too while one is installed) when it is newer than the installed one, in the recorded form with the same verification as `worker install`, and update the install record; `--restart` restarts a detached worker or the container on it, rolling back if it does not start |
| `pidgen worker uninstall [--purge]` | Stop a detached worker or the container and remove the installed worker (`uv tool uninstall`, or the container and image) and its install record; `--purge` also removes the worker home (and the container's volume) |
| `pidgen worker verify` | Re-check the installed wheel's or image's digest and provenance against the install record |
| `pidgen worker enroll [--label <label>] [--install\|--no-install] [--replace-credential] [-- args]` | Install the worker when it is missing and `--install` is given (the verified install of `worker install`), then create an enrollment (`POST /workers/enrollments`) and run `pidgen-worker enroll --server <server> --no-start`; it never asks and never starts the worker (`pidgen worker start --detach` does). A worker home whose `worker.env` already holds a credential is refused (exit 5, `WORKER_CREDENTIAL_PRESENT`) before anything is installed or created, unless `--replace-credential` moves it aside first. A host id Pidgen refuses as taken is exit 5, `WORKER_HOST_TAKEN`; a name the Account already holds is exit 5, `WORKER_NAME_TAKEN`, and creates nothing |
| `pidgen worker start [--detach] [-- args]` | Run `pidgen-worker` in the foreground, or manage it in the background with `--detach`; a container install runs the named container `pidgen-worker` |
| `pidgen worker stop [--force]` | Stop the detached worker or container, killing it after `--timeout` only with `--force` |
| `pidgen worker restart [--force]` | Stop the detached worker or container as `worker stop` does, then start it detached again with the arguments it was started with (its run record's command, or the container's `ai.pidgen.worker.args` label) and the two-second startup check of `worker start --detach`. `data` is `stopped` (what `worker stop` reports for the old worker), `record` (the new run record) and `running: true`. Nothing running (no record, or a stale one) exits 4 with `WORKER_NOT_RUNNING` and starts nothing; a worker still running after `--timeout` exits 8 with `TIMEOUT` and is left running, unless `--force` kills it and the restart continues; a new worker that exits during the startup check exits 1 with `WORKER_EXITED` and the last 20 log lines in `error.details.log_tail`. It takes no `-- args`: to change them, run `worker stop`, then `worker start --detach -- <args>` |
| `pidgen worker status [--host <host_id>]` | Show the detached worker record and local liveness and, with a credential, the App Service's record of this worker (`GET /workers`) |
| `pidgen worker doctor [-- args]` | Run `pidgen-worker doctor --json` (with `docker exec` in the container) and return its report |
| `pidgen worker login claude\|codex` | Sign the coding agent in to its default home, which the worker reads: run its login with the terminal inherited (`claude auth login`; `codex login --device-auth`), then its status command (`claude auth status`; `codex login status`) |
| `pidgen worker subscriptions <worker>` | Show a worker's provider subscriptions per harness: primary, active, login, entitlement, quota and pause (`GET /workers/{host_id}/subscriptions`) |
| `pidgen worker subscriptions use <worker> <harness> <label> [--move-continuing]` | Make one of a worker's subscriptions primary for a harness (`GET /workers/{host_id}/subscriptions`, then `PUT /workers/{host_id}/subscriptions/{harness}/primary`) |

`worker enroll`'s `data` is `enrollment` (the enrollment's id, Account, label, fingerprint, creator,
creation and expiry times, and state), `install` (each install option the server returned, its
`form`, `artifact` and `install` step, reported and never run), `eula`, `installed` (the install
record of the worker the CLI installed before creating the enrollment, as `worker install` reports
it, or `null` when the worker was already present), `worker` (the `pidgen-worker` it ran),
`install_id` (this install's id, sent as `install_id` with the enrollment, or `null` when none was
sent: an invalid `install-id` file, or a server that refused the field with `422` and was sent the
create again without it) and `enrolled: true`. The one-time token is never in it. A missing worker is installed first, so a failed or declined install spends no
enrollment ([Workers](workers.md#enroll-a-worker)).

`pidgen-worker enroll` skips the token exchange when the worker home's `worker.env` already holds a
credential (`PIDGEN_NODE_TOKEN`), so an enrollment created then would never be used. Without
`--replace-credential`, `worker enroll` refuses such a home before it installs anything or creates
an enrollment: exit 5 with `WORKER_CREDENTIAL_PRESENT`, `error.details.path` naming the file, and a
message naming both ways on: `pidgen worker start` to use the saved credential, or
`--replace-credential` to enroll anew. `--replace-credential` renames `worker.env` to
`worker.env.replaced-<UTC timestamp>` (for example `worker.env.replaced-20261018T190600Z`) in the
same folder, mode 0600, just before creating the enrollment, and reports the new path in
`data.replaced`; the CLI never reads the credential's value, prints it or returns it, and never
deletes the moved file. When the server refuses the enrollment the file is put back. With no
`worker.env`, or one without a credential, the flag changes nothing and `data` has no `replaced`.

When `pidgen-worker enroll` exits 1 reporting `HTTP 409 WORKER_HOST_TAKEN`, the server refused the
worker's host id because another worker holds it, in this Account or another (host ids are unique
across Accounts). `worker enroll` then exits 5, `WORKER_HOST_TAKEN`, with the refused host id in
`error.details.host_id` (from the worker's refusal, else the `--host-id` after `--`), the
enrollment's summary and `error.details.exit_code`. Any other failure of `pidgen-worker enroll` is
still exit 1, `ENROLL_FAILED`. After either, and after any other failure once the enrollment was
created, `worker enroll` withdraws the enrollment (`DELETE /workers/enrollments/{enrollment_id}`)
before it exits, keeping the failure's code and exit code: `error.details.withdrawn` is `true` and
the message ends `The enrollment <id> was withdrawn.`; when the withdraw fails, `withdrawn` is
`false`, `error.details.withdraw_error` says why, and the enrollment expires on its own. The worker's
output still goes to standard error, with the one-time token replaced by `[redacted]`.

When the App Service refuses `POST /workers/enrollments` with `409` and `WORKER_NAME_TAKEN`, the
Account already holds the enrollment's name, by a live worker or a pending enrollment (another
person's pending enrollments are not visible to the CLI). No enrollment was created and
`pidgen-worker` does not run. `worker enroll` exits 5, `WORKER_NAME_TAKEN`, with the refused name in
`error.details.display_name`, the name the server suggests in `error.details.suggested_name`, and a
message naming `pidgen worker enroll --label <suggested_name> -- --host-id <suggested_name>`. A
replaced credential is put back. It never asks for another name.

`worker install`'s `data` is the install record — `form`, `version`, `artifact`, `digest`,
`identity`, `verified_at`, `installed_at`, `location`, `file` (`null` for a container) and, for a
container, `volume` — plus `installed` (`false` when the recorded version was already installed
and `--force` was not given). It prints the licence notice and every command it runs to standard
error first; the notice names the licence and its location, gives its notice, says installing
accepts it, and ends with `Read it: https://pidgen.ai/legal/eula`, the link to its full text
(standard output and the JSON envelope do not carry it), and refuses with `RUNTIME_UNAVAILABLE` (exit 2, no `uv`, or no `docker` and `cosign`
for `--runtime container`), `RELEASE_UNSUPPORTED` (exit 5) or `PROVENANCE_INVALID` (exit 5,
nothing pulled, installed or run). `worker verify`'s `data` is `checks` (`digest` and `provenance`, in `pidgen doctor`'s
shape) and `record`; a failed check exits 5 with `PROVENANCE_INVALID`, and no install record exits
4 with `WORKER_NOT_INSTALLED` ([Workers](workers.md#install-the-worker)). The release route is
agreed with the App Service and not yet published, so `install` and `update` wait on the server
publishing it.

`worker update`'s `data` is the new install record plus `updated` (`false` when the record already
names the release, or, without `--version`, when nothing on the installed version's track is newer
than it: an update never installs an older release, and only `--version` does; nothing is
installed or restarted and no licence notice is printed), `previous_version`, `running` (whether a
detached worker or the container runs), `restarted` and, after a restart, `worker` (the new
detached worker or container record). It prints the same licence notice as `worker install`, ending
with `Read it: https://pidgen.ai/legal/eula`, on standard error. Without `--restart` a running worker keeps the old version
until it is restarted. If the restarted worker exits during the startup check, the previous
version is reinstalled and restarted and the command exits 1 with `UPDATE_ROLLED_BACK`
([Workers](workers.md#update-the-worker)). No install record exits 4 with `WORKER_NOT_INSTALLED`.

`worker uninstall`'s `data` is `uninstalled` (the removed install record), `stopped` (the detached
worker or container it stopped, as `worker stop` reports it, or `null`), `removed` (what was
removed), `purged` and `worker_home`. A stale detached run record is removed with the install. No
install record exits 4 with `WORKER_NOT_INSTALLED` ([Workers](workers.md#uninstall-the-worker)).

`worker status`'s `data` is `installed` (`true` when a valid install record exists, `false` when
there is none), `record` (the detached worker record, the container's record for a
container install, or `null`), `running` and
`update` (`installed`, `current`, `needed` and `reason`: `protocol_unsupported`,
`protocol_outdated` or `newer_available`, or `null`; [Workers](workers.md#is-an-update-needed)). With a
credential it adds `server` (`host_id`, `enrolled`, `worker` — the matching `GET /workers` entry
with its last-seen time, protocol state and git credential coverage, or `null` — and the service's
`service_protocol` and `accepted_protocols`) and `warnings`. An unreachable or refusing server
leaves `server: null`, adds a warning with the error's code, and still exits 0
([Workers](workers.md#the-app-services-view)). With no install record, as after
`worker uninstall`, it reports the worker as not installed (`installed: false`) and still exits 0,
not `WORKER_NOT_INSTALLED`; in a terminal it starts with `Worker not installed.` and names
`pidgen worker install`, and when the server still lists this machine as enrolled it says the
enrollment and the worker's credential were kept because `--purge` was not given.

### worker subscriptions

```console
$ pidgen worker subscriptions worker-host.example.com
$ pidgen worker subscriptions use worker-host.example.com claude claude-fallback-1 [--move-continuing]
```

A worker owns its provider subscriptions: which exist, their fallback order and the primary live
in its `node.yaml`, and the App Service reads what the worker advertises and relays commands to it.
`<worker>` is the worker's host id, as `pidgen worker status` and `GET /workers` report it.

- `pidgen worker subscriptions <worker>` — `data` is the server's `data` unchanged (`--format json`,
  the default): `host_id`, `connected`, `advertised` (whether the worker has reported its
  subscriptions) and `harnesses`, each with its `harness`, `primary`, `active` and `subscriptions`
  in fallback order. Each subscription has its `label`, whether it is the `primary` and the
  `active` one, `login` (`ready`, `not_ready`, `unknown` or `duplicate`), `entitled`,
  `last_error`, `quota` (each window's `window`, `used_percent`, `resets_at` and `observed_at`, or
  `null` when unknown), `paused`, its `pauses` (each with its `capacity_key`, `window` and
  `resets_at`) and `resets_at`, when the pause lifts. Quota is as of `observed_at`, never live.
  Human output labels connection and advertisement state, each harness's primary and active
  subscriptions, login errors, entitlement, complete quota/pause windows and observation times.
  Summaries retain each quota window's age (`five_hour 42% (12m ago)`) and pause (`paused until …`).
- `pidgen worker subscriptions use <worker> <harness> <label>` reads the worker's subscriptions first
  and sends `PUT /workers/{host_id}/subscriptions/{harness}/primary` with `{label,
  expected_primary, move_continuing_steps}`, where `expected_primary` is the primary that fresh
  read reports, so a change someone made meanwhile is refused rather than overwritten.
  `--move-continuing` sends `move_continuing_steps: true`: the worker's continuing steps of that
  harness move to the new primary and carry their conversation at their next attempt; without it
  they keep their subscription and only new steps use the new primary. `data` is the change's
  result unchanged: `request_id`, `harness`, `outcome` (`applied`, or `unknown` when the worker
  did not answer within the App Service's reply timeout — the next read shows what happened),
  `primary`, `active` and `detail`. It exits 0 for either outcome. There is no
  preview: the route has none, and the expected primary guards the change.
- Each refusal exits 5 with the server's code, a one-line `error.message` from the CLI, and the
  server's own wording in `error.details.server_message`:

  | Code | Meaning |
  |---|---|
  | `ENTITLEMENT_LIMIT_REACHED` | The Account's plan does not include `multiple_subscriptions`, so the App Service does not switch a worker's subscriptions. Change it on the worker with `pidgen-worker subscriptions use`, which is always allowed. |
  | `WORKER_OFFLINE` | The worker is not connected; the App Service queues no command. |
  | `SUBSCRIPTION_STALE` | The worker's primary changed after the read; nothing was changed. Read again and retry. |
  | `SUBSCRIPTION_UNAVAILABLE` | The label is not declared for that harness, not logged in, or a duplicate login. |
  | `SUBSCRIPTIONS_NOT_ENTITLED` | The worker has not been told the Account holds `multiple_subscriptions`. |

- A harness the worker does not advertise exits 4 with `HARNESS_NOT_ADVERTISED`
  (`error.details.advertised` lists the harnesses it does), and no `PUT` is sent. An unknown worker
  is the server's `WORKER_NOT_FOUND` (exit 4); a caller who is not an Account Owner or
  Administrator is `FORBIDDEN` (exit 3).
- A missing or empty worker, harness or label is a usage error (exit 2), and a label the request
  schema refuses (1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit) is
  `INPUT_INVALID` (exit 2); nothing is sent. `use` is a subcommand, so a worker whose host id is
  `use` cannot be read with this command.

## skills

See [Skills](skills.md).

| Command | Does |
|---|---|
| `pidgen skills install [--agent claude\|codex\|pi\|all] [--scope user\|project] [--force]` | Copy the bundled skills into an agent's skill directory |
| `pidgen skills status [--agent claude\|codex\|pi\|all] [--scope user\|project]` | Report installed skills that are stale or edited, and whether the CLI's API contract differs from the server's |

## feedback

| Command | Does | Route |
|---|---|---|
| `pidgen feedback --kind not-working\|improvement\|other <message>` | Send product feedback about Pidgen itself | `POST /feedback` |

`pidgen feedback` is one command with no verb. It tells the people who build Pidgen that something
is not working, could be better, or anything else; it is not about the work in a ticket.

| Flag | Meaning |
|---|---|
| `--kind <kind>` | Required. `not-working`, `improvement` or `other`, sent as `kind` `not_working`, `improvement` or `other`; any other value is `CLI_USAGE` (exit 2) and sends nothing |
| `<message>` | The feedback, 1–4000 characters |
| `--message-file <file\|->` | Read the message from a file instead of the argument; `-` reads standard input. Trailing line breaks are dropped. Giving both, or neither, is `CLI_USAGE` (exit 2) |
| `--no-contact` | Send `contact_ok: false`: Pidgen may not contact you about it. Without it `contact_ok` is `true` |
| `--after <command> <exit>` | The pidgen command the feedback is about and its exit code, sent as `last_command` and `exit_code`. Both values are required and the exit code is an integer; a message may follow them |

The body is `{kind, message, contact_ok, context}`, where `context` says where the feedback came
from: `{source: "cli", cli_version, os, arch, node_version, api_base}` (`os` and `arch` as Node
reports them, `api_base` the selected profile's server), plus `last_command` and `exit_code` only
when `--after` is given. The body is validated against `FeedbackSubmission` in the public API
document before anything is sent: an empty or over-long message is `INPUT_INVALID` (exit 2) and
sends nothing. `data` is the server's report: `id`, `reference` (8 hex characters to quote when
following up), `kind` and `created_at`.

```sh
pidgen feedback --kind not-working --after "pidgen ticket show PIDGEN-12" 4 "It said not found, but the ticket exists."
pidgen feedback --kind improvement --message-file idea.md --no-contact
```

Two refusals keep their code and exit 5, whatever the status: `FEEDBACK_RATE_LIMITED` (a 429: too
much feedback recently; try again later) and `FEEDBACK_MESSAGE_TOO_LONG` (a 422: the server takes
less than was sent). Other errors exit as their status does ([Output and exit
codes](output-and-exit-codes.md)).

## setup

| Command | Does | Route |
|---|---|---|
| `pidgen setup [--runtime wheel] [--version <version>] [--label <label>] [--url <url>] [--test] [--agent claude\|codex]… [--sessions <agent>=<n>]… [--plan <agent>=<plan>]… [--accept-licence] [--verbose]` | The guided path from a fresh machine to a verified worker connected to the App Service | The routes of the commands it runs, and `GET /workers` |

```console
$ pidgen setup [--runtime wheel] [--version <version>] [--label <label>] [--url <url>] [--agent claude|codex]… [--sessions <agent>=<n>]… [--plan <agent>=<plan>]… [--accept-licence] [--verbose]
```

`pidgen setup` is the primary entry point and the CLI's only interactive command: every other
command never asks. It is composed of the scriptable commands below, so the whole path can be
scripted afterwards. The screen shows only the current action: each task (installing uv, a coding
agent or the worker, enrolling, starting, the worker's checks) is a spinner that collapses to one
line, such as `◇  pidgen-worker 2.11.0 installed and verified`, and no command line (`$ …`) or
command output reaches standard error. Each run writes the commands as `$ pidgen …`, their full
output, each step's start, end and result, each question and answer and every error in full to the
setup log, `~/.pidgen/logs/setup-<start time>.log` (`$PIDGEN_HOME/logs` when set; mode 0600;
credentials written as `[redacted]`; the newest ten kept). `--verbose` shows each task's commands
and their output under it as it runs, and keeps them after it succeeds. A failing task keeps the
last ten lines of its output from this run on screen, in its one failure block. It draws in clack's
frame on standard error, starting with `┌  Pidgen setup`, and asks each
question as a prompt you answer with the arrow keys, space and Enter: a checkbox list, a choice, a
text field or a yes/no. Each answered question collapses to one line, such as
`◇  Coding agents · Claude Code, Codex`; an answer given in advance by a flag is shown the same way,
with `(from --sessions)` and the like. A successful run ends with `└  Done in <m> min <s> s`: in a
terminal, on standard output, followed by a summary card (the Account, the worker's name, version
and state, each coding agent's sessions, how to manage the worker, and the one next thing to do);
with JSON on standard output, on standard error. The generic rendering of `data` is not shown.
`data.steps` reports its eight parts by `id`:

| Step | `id` | Runs | Does |
|---|---|---|---|
| 1. Check this machine | `check` | `pidgen doctor` | Shows one line, `This machine is ready · <Linux or macOS> · Node.js <major.minor> · git <major.minor>`; the checks a later step fixes and warnings that do not apply to what setup does (the container runtime's `cosign`) go only to the setup log, and other warnings are one `▲` line each. When `uv` is missing, asks `uv installs the worker and isn't on this machine. Install it?`: yes runs uv's installer, `curl -LsSf https://astral.sh/uv/install.sh \| sh`, and uses the installed `uv` (from `~/.local/bin` while `PATH` does not have it yet) for the rest of setup; no stops with `RUNTIME_UNAVAILABLE` (exit 2) and that command as the fix. A `uv` already in `~/.local/bin` is used without asking. Then it runs the [doctor](#doctor) checks against the server it will sign in to and stops on a failing check a later step cannot fix, with each check's fix. A failing `credential` (fixed by signing in) or `worker` (fixed by installing) does not stop it |
| 2. Sign in to Pidgen | `sign-in` | `pidgen auth login <url>` | Device-code login. When the User belongs to more than one Account it asks which one the worker serves, a choice of the Accounts by name with your role in each (`pidgen account use <ACC-…>` makes it the default; an Account with no stored credential is signed in again and approved for it). The sign-in block leads with the link that carries the code (`verification_uri_complete`), then the address and the code, and a spinner waits for the approval; it collapses to `Signed in as <email> · <Account> · <Role>`. Then it decides whether the credential may enroll workers, from the role and token scopes `GET /me` publishes: it may when the scopes include `workers:enroll`, which an Account Owner or Administrator holds. When it may not, and this machine's worker is not enrolled, setup stops here, before anything is installed, with `ENROLL_NOT_PERMITTED` (exit 3), naming those roles and the Personal API Token path, `pidgen auth login <url> --with-token --account <ACC-…>` with a token that has `workers:enroll`. Then it says what was done before this run (see **Re-running**) |
| 3. Choose coding agents | `agents` | — | Asks which coding agents the worker runs, as checkboxes of Claude Code and Codex with the ones on `PATH` ticked; a missing one is labelled `not installed · setup installs it with npm`, and ticking it is the consent: setup installs it with `npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex` and asks nothing more. Pi is shown, disabled, when it is on `PATH`: the worker runs it, and setup doesn't manage it. Confirming none keeps the question open with `Choose at least one.` `--agent claude` and `--agent codex` (repeatable) answer in advance, and a missing agent they name is installed the same way. When npm may not write its global directory (EACCES), setup prints the command for the person to run and asks whether it finished; no, or an agent still not on `PATH`, stops with `AGENT_NOT_FOUND` (exit 2) and the install command as the fix; another npm failure stops with `INSTALL_FAILED` (exit 1) |
| 4. Sign in to coding agents | `agent-login` | `pidgen worker login <agent>` for each chosen agent | Runs each chosen agent's status command first (`claude auth status`, `codex login status`) and prints `<agent>: signed in` for those that are; then, for each that is not, says `<agent> needs you to sign in. Its own sign-in runs here; setup continues after it.` and runs `pidgen worker login <agent>` when you press Enter. An agent that cannot say whether it is signed in is asked about (`Sign in now?`, default *No, it's signed in*). `skipped` when every chosen agent is signed in |
| 5. Size coding agent sessions | `capacity` | — | Asks, for each chosen agent, `<agent>: how many sessions should run at once?`: a choice of numbers, each with the plans it suits as a hint (Claude Code: 1 *Pro, or not sure*, 2 *Max 5x, API key, Team or Enterprise*, 4 *Max 20x*; Codex: 1 *Plus, or not sure*, 2 *Business, Enterprise or API key*, 3 *Pro*), plus *Custom…*, which takes a whole number from 1 (another answer keeps it open with `Enter a whole number, 1 or more.`). It starts on the lowest, or, on a re-run, on the cap in the worker's `node.yaml`. The hints are starting values, not the providers' limits. `--sessions <agent>=<n>` (repeatable, `n` from 1 to 64) answers in advance; so does `--plan <agent>=<plan>`, with the plans `claude=pro\|max-5x\|max-20x\|api\|not-sure` and `codex=plus\|pro\|business\|api\|not-sure` (Claude Code Pro 1, Max 5x 2, Max 20x 4, API key, Team or Enterprise 2, Not sure 1; Codex Plus 1, Pro 3, Business or Enterprise 2, API key 2, Not sure 1). Another value, or both flags for one agent, is `CLI_USAGE`. The `enroll` step applies the caps |
| 6. Install the worker | `runtime` | — | Nothing is asked while setup offers only the `wheel` runtime (installed with `uv`); the container runtime is *planned* |
| 6. Install the worker | `install` | `pidgen worker install --runtime <runtime>`, then `pidgen worker verify` | Asks one question once the release is chosen and before anything is downloaded or run, `Install pidgen-worker <version> and accept its licence?`, with one line naming the licence (`The worker is proprietary software under the <licence name>.`) and one linking its full text (`Read it: https://pidgen.ai/legal/eula`); setup prints no other licence notice. The setup log records both lines under the question, also when `--accept-licence` answers it and the screen shows only the answered line. `--accept-licence` answers yes in advance. No stops setup with `SETUP_CANCELLED` (exit 2): the worker wasn't installed. Then it installs the release under the spinner `Installing pidgen-worker <version>…`, verifies it (`Verifying it was published by Pidgen's release workflow…`), and collapses to `pidgen-worker <version> installed and verified`; each verification is in the setup log |
| 7. Enroll and start the worker | `enroll` | `pidgen worker enroll --label <name> -- --host-id <name>`, then `pidgen worker start --detach` | Enrolls this install's worker under its name, which is both the enrollment's label and the worker's host id. Before creating an enrollment setup always asks `Worker name`, unless `--label` answers it, with a suggestion filled in that Enter accepts and the person may edit: the removed worker's name when this install's `worker.env` names a worker the Account lists as removed, else this host's name, or, when a live worker of the Account holds it (compared without regard to case), the next free name, `<name>-2`, then `-3`, setup first saying the Account already has a worker by that name; the question stays open on a name that is empty, over 100 characters or held by a live worker of the Account, and the setup log records the suggestion and why. When the App Service refuses the enrollment with `409` `WORKER_NAME_TAKEN` (the Account holds the name by a live worker or a pending enrollment), nothing was created: setup shows `▲  <name> is taken in Pidgen, so this worker needs another name.` and asks `Worker name` again with `error.details.suggested_name` filled in. A `--label` never asks: one the Account already lists, or one the server refuses with `WORKER_NAME_TAKEN`, stops with `WORKER_NAME_TAKEN`, exit 5, its fix `pidgen setup --label <suggested name>`, creating and starting nothing. When Pidgen refuses the host id as taken, `pidgen-worker enroll` reporting `HTTP 409 WORKER_HOST_TAKEN`, setup shows `▲  <name> is taken in Pidgen, so this worker needs another name.`, asks for a name defaulting to the next free one and enrolls under the answer with the same enrollment (one new enrollment only if that fails, the unused one named in the setup log), while with `--label` it stops with `WORKER_HOST_TAKEN`, exit 5, its fix `pidgen setup --label <next free name>`, starting nothing; a worker the Account revoked, or no longer lists, is enrolled again after the person agrees, `Enroll it again?` defaulting to yes, with `pidgen worker enroll --replace-credential` so the removed worker's `worker.env` is moved aside to `worker.env.replaced-<UTC timestamp>` (the setup log records its new path) and the worker redeems the new enrollment, and declining stops with `SETUP_CANCELLED`, exit 2; a `worker.env` holding a credential for another server, or one naming no server, stops the step before any enrollment is created with `WORKER_CREDENTIAL_PRESENT`, exit 5, naming the file and that server. Setup then applies the caps with `pidgen-worker capacity set <agent> --max <cap>` for each chosen agent, `--max 0` for each other harness the worker knows (`claude`, `codex`, `pi`), and `pidgen-worker capacity set prompts --min 1 --max <sum of the caps>`, where exit 0 with a line of output reading `saved`, `saved (…)`, `saved, apply pending` or `saved; …` is success and exit 1 stops the step with `CAPACITY_REFUSED` and the command's message (any other answer is `CAPACITY_FAILED`); then starts the worker detached, never when the worker home's `worker.env` holds no `PIDGEN_NODE_TOKEN` (that stops with `ENROLL_FAILED`, exit 1, naming `pidgen feedback --kind not-working`), then reads `GET /workers` every two seconds until the App Service reports the worker `connected`, for up to the global `--timeout` (120 seconds by default) |
| 8. Prove the worker works | `prove` | `pidgen worker doctor` | Runs the worker's own checks; the one next thing to do is `data.steps[…].next` and the card's `Next:` line: `pidgen skills install`, or, with the skills installed, `pidgen ticket template` to file a first ticket |

- `--agent`, `--sessions`, `--plan`, `--accept-licence`, `--runtime`, `--version` and `--label`
  answer in advance: `--runtime` names the form, `--version` picks the release (default: the server's `current`), and `--label` names the worker
  (default: this host's name). `--url` is the server (default: the configured one, else the
  hosted server, `https://api.pidgen.ai`); naming another server than `PIDGEN_API_URL` is `CLI_USAGE`.
- **Resuming.** Run it again and it resumes: a signed-in profile for the server (a credential
  `GET /me` accepts) skips `sign-in`; an installed worker (an install record for the requested
  version, or, without `--version`, one the server still accepts) skips `runtime` and `install`;
  an enrolled machine skips the enrollment (this install's worker home, `$PIDGEN_HOME` or
  `~/.pidgen`, has a `worker.env` with a non-empty `PIDGEN_NODE_TOKEN` whose `PIDGEN_SERVICE_URL`
  is the server's origin, and `GET /workers` lists its `PIDGEN_LOCALITY_DOMAIN` as an unrevoked
  host id; a worker listed under this host's name that is not this install's is never adopted), and a
  running detached worker skips the start. The caps chosen at `capacity` in this run are applied
  again on an enrolled host; `enroll` is `skipped` only when the enrollment and the start are and
  no caps were applied. A credential that
  cannot read `GET /workers` (a Personal API Token) counts the worker home's credential for the
  server as enrolled.
- **Re-running.** When every action is done (the worker installed, enrolled and running, and its
  `node.yaml` sets coding agents' sessions), setup shows
  `◇  Already set up · <Account> · <agents> · pidgen-worker <version> · running` and asks
  `What do you want to do?`: *Check everything and stop* (no more questions; the agents, caps,
  install and enrollment are `skipped`, then the connection and the worker's checks), *Change
  coding agents or sessions* (the questions again), and, only when `pidgen worker update` would
  install a newer release by its rule (the newest of the server's current series on the installed
  version's track, so a machine on `2.11.1b1` is offered `2.11.1b2` and never `2.11.0`), *Update
  the worker to <version>* (`pidgen worker update --restart`
  as the `install` step). *Check everything and stop* says
  `◇  pidgen-worker <new> is available (<old> installed) · update with pidgen worker update` when
  such a release is out, and installs nothing. `--agent`, `--sessions` or `--plan` answer it:
  change. On a part-done machine the done actions collapse into one line, `◇  Already done · …`,
  and setup continues.
- **A newer release before starting.** On every other run that keeps an installed worker (a
  part-done machine, before the `enroll` step starts or restarts it), the `install` step compares
  the installed version with the release `pidgen worker update` would install by the same rule.
  When one is newer it asks once, `pidgen-worker <new> is available (<old> installed). Update before
  starting?` (default yes). Yes asks the licence question for the new release
  (`Install pidgen-worker <new> and accept its licence?`, as step 6 does), then runs
  `pidgen worker update --restart` as the `install` step (`done`, its `command` and `version`), so
  the `enroll` step starts the new release. No, to either question, keeps the installed release
  (`install` is `skipped`) and says `pidgen-worker <old> is installed · update it later with pidgen
  worker update`. `--accept-licence` answers both questions yes in advance. Nothing is asked when
  nothing is newer (a newer pre-release is not offered while a final release is installed), when
  `--version` names the release, or when the release list or package index cannot be read (a note
  in the setup log, not a failure). The question, its answer and the comparison are in the setup
  log.
- **Waiting.** A credential that cannot read `GET /workers` cannot see the worker connect: the
  `enroll` step reports `connected: null` and names `pidgen worker status` to check with an Owner's
  or Administrator's sign-in. Otherwise a worker not reported `connected` before the timeout exits 8
  with `WORKER_NOT_CONNECTED`; `error.details` has `host_id`, the server's `worker` record, whether
  the worker is `running`, and its `log`.
- **Cancelling.** Ctrl-C at any question stops setup with `■  Setup cancelled. Everything before
  this is kept.` and `└  Run pidgen setup again to continue.`; it exits 2 with `SETUP_CANCELLED`,
  and `error.details` has the `step` it stopped at and the `steps` so far. What finished before is
  kept, so running it again resumes.
- **Failures.** Setup never hides a failure: a failed step stops it, and nothing after it runs. The
  error keeps the failing command's own `code` and exit code; its message names the step
  (`Setup stopped at <title>`), the command, the error and the fix, ending with
  ``Run `pidgen setup` again to continue from here.``, and `error.details` adds `step`, `command` (the command that failed), `error`
  (`{code, message, details}`), `fix`, `steps` so far, and `setup_log`, the setup log's path (a failing command's own `log`, such as the worker's, is kept). In a terminal
  the screen shows one block and nothing else: `■` and what failed and why, the one fix, the setup
  log's path, and `└  Run pidgen setup again to continue from here.`; standard output shows nothing
  more (no `error <code>:` line, no details). A credential that may not enroll stops at `sign-in`
  with `ENROLL_NOT_PERMITTED` (exit 3), before anything is installed or enrolled.
- **No terminal.** Without a terminal on standard input and standard error it asks nothing, runs
  nothing, and exits 2 with `TERMINAL_REQUIRED`; `error.details.commands` lists the equivalent
  commands in order: `pidgen doctor`, `pidgen auth login <url>`, `pidgen worker login <agent>` for
  each `--agent`, `pidgen worker install`,
  `pidgen worker verify`, `pidgen worker enroll --label <label> -- --host-id <label>`, the `pidgen-worker capacity set`
  commands when `--agent` and a `--sessions` or `--plan` for each agent are given, `pidgen worker start --detach`,
  `pidgen worker status` (to see the worker connect) and `pidgen worker doctor`, with `--runtime`,
  `--version` and the global `--profile` and `--account` as given.
- Besides the worker, setup installs only `uv` and the coding agents chosen at `agents`, and only
  when the person says yes (or ticks them): when `git` or Docker is missing, the `check` step's fix says how to
  install it. A missing harness does not stop the `check` step: choosing coding agents fixes it.

`data` is `steps`, one entry per `id` that ran, in order: `id`, `status` (`done`, `skipped` or
`failed`), `command` (the commands the step runs, joined with `&&`, whether or not it was skipped;
`null` for `runtime`, `agents` and `capacity`, and for `agent-login` with no agent chosen) and `summary`. `agents` adds `agents` (the chosen kinds) and `installed` (those setup installed);
`agent-login` adds `logins` (each chosen agent's `ready`, `not_ready` or `unknown`); `capacity` adds `plans` (the plan id of each agent `--plan` answered for) and `caps` (each chosen agent's cap). `sign-in` adds `account` and `enroll` (`allowed`, `account`,
`kind`, `role`, `scopes`, `roles` that may enroll, the `scope` that may, and `token_command`);
`runtime` adds `runtime`; `install` adds `version`; `enroll` adds `host_id` (the worker's name), `connected` and, when it applied them, `capacity` (each harness's `--max`, and `prompts`);
`prove` adds the worker's `report` and `next`, the next command.

## doctor

| Command | Does | Route |
|---|---|---|
| `pidgen doctor` | Diagnose this machine and its connection to Pidgen before anything is installed | `GET /health`, `GET /me`, `GET /workers/releases` (pending) |

```console
$ pidgen doctor
```

`pidgen doctor` is one command with no verb and no flags beyond the global ones. It changes nothing
and works with nothing configured and no worker installed. It differs from `pidgen worker
doctor`, which runs the installed worker's own checks ([Workers](workers.md#check-this-machine)).

`data.checks` is a list of `{id, status, summary, fix}`, always in this order. `status` is `ok`,
`warn`, `fail` or `skip`; `summary` is one sentence saying what was found; `fix` is the command or
address that resolves the problem, or `null` when there is nothing to fix. `pidgen worker verify`
reports its checks in the same shape.

| Check | Looks at | Fails, with its fix, when |
|---|---|---|
| `node` | The Node.js version this CLI runs on | It is older than 22.12 (`https://nodejs.org/en/download`) |
| `git` | `git` on `PATH` and the version `git --version` reports | It is missing or older than 2.38. The fix is this system's command: `xcode-select --install` or `brew install git` on macOS (`brew install git`, with Homebrew before `/usr/bin` on `PATH`, for an older one); on Linux, the distribution's from `/etc/os-release` (`ID`, then `ID_LIKE`): the git-core PPA on Ubuntu and its derivatives, `apt` on Debian, `dnf` on Fedora and RHEL-like systems, `pacman` on Arch, `apk` on Alpine, `zypper` on openSUSE and SLES, else `https://git-scm.com/downloads/linux` ([the full list](install-worker.md)) |
| `server` | `GET /health`, sent without the credential: the server answers as Pidgen and its API version window includes this CLI's | The configuration cannot be read (`chmod 600 <file>` for loose permissions); the server is not Pidgen; its window excludes this CLI's API version (`npm install -g pidgen@<channel>` when the CLI is too old, the channel being the one this CLI was released on: `alpha` for an alpha, else `latest`); or it cannot be reached (the health address) |
| `credential` | `GET /me`: the profile's credential is valid, the current Account's role, the token kind (`cli` or `pat`) and scopes the server reports for it, and whether it may enroll workers | No credential is stored for the Account, or the server refuses it (`pidgen auth login <url> --account <ACC-…>`) |
| `runtime` | `uv` on `PATH` for the wheel runtime; `docker` and `cosign` on `PATH` for the container runtime | Neither runtime is complete (the uv or cosign installation page), or the platform is not Linux or macOS |
| `releases` | `GET /workers/releases`, the server's worker release list, read with no credential and no Account ([published](api-compatibility.md#domains-contracts-requests-and-worker-releases)) | The server does not answer it, or its answer does not match the published document (the route's address) |
| `harness:<kind>` | One check per harness the release list names: its command on `PATH`. The CLI carries no harness list of its own | No harness the list names is on `PATH` (install the harness command); one missing beside another that is found is `warn` |
| `worker` | The install record of `pidgen worker install` against the releases the list accepts, and for a wheel install whether `pidgen-worker` first on `PATH` is that worker (or a symlink to it) | The installed release is one the server no longer accepts or does not list (`pidgen worker install`); a `supported` release that is not `current`, or no install yet, is `warn` with the same fix. Another `pidgen-worker` first on `PATH` is named in the summary, and makes a `current` install `warn` with `export PATH="<worker home>/worker/bin:$PATH"` as the fix |

- `credential` is `skip` when the `server` check fails: the credential is never sent to a server that
  did not pass. With no server configured, the checks run against the hosted server,
  `https://api.pidgen.ai`.
- `credential` may enroll workers when the token's scopes include `workers:enroll`. For a CLI token
  the server reports the scopes the User's current role grants, so an Account Owner or Administrator
  may and a Member may not. A credential that is valid but may not enroll is `warn`, with what to do.
- `runtime` passes with one complete runtime. A wheel runtime beside `docker` without `cosign` is
  `warn`, with the cosign installation page.
- `releases`, the `harness:<kind>` checks and `worker` come from the release list. When the `server`
  check fails the list is not read: `releases`, `harness` (standing for the harness checks) and
  `worker` are `skip`. When the list cannot be read, `releases` fails and `harness` and `worker` are
  `skip`. The release list needs no credential, so it is read even when `credential` fails. Until
  the App Service publishes the route, `releases` fails against a real server.

A failing check exits 1 with `DOCTOR_FAILED`; the message names the failing checks and
`error.details` is the full report (`{checks}`). Warnings and skips alone exit 0 with `ok: true`.
Arguments and unknown options are `CLI_USAGE` (exit 2) and send nothing.

## api

`pidgen api <get|post|put|patch|delete> <path> [--query key=value]... [-f <file|->]` sends one
request to a public-API route with the selected profile's credential. In JSON mode, it prints one
envelope; terminal stdout defaults to human-readable output. It exists so a skill never needs
`curl`; prefer a named command when one exists, and use `--format json` to consume structured results.

| Flag | Meaning |
|---|---|
| `<path>` | A path such as `/tickets/PIDGEN-12`, with or without the `/api/v1` prefix |
| `--query <key=value>` | Add a query parameter; repeat for more. A key given twice is refused |
| `-f, --file <file\|->` | Request body as JSON or YAML ([Input files](#input-files)); `-` reads standard input |

- The path and method must match a path template and method in the public API document bundled
  with the CLI (the committed `contracts/openapi.json`): `/tickets/PIDGEN-12` matches
  `/api/v1/tickets/{ticket_id}`, and a template parameter matches exactly one non-empty path segment. When
  several templates match, the one with the most literal segments wins. Otherwise the command exits
  2 with `PATH_NOT_PUBLIC` and sends nothing; `error.details` has `method`, `path`, and, when the
  path is documented for other methods, `allowed_methods`. Paths with `.` or `..` segments, or with
  an encoded `/` or `\` in a segment, are never public. Put query parameters in `--query`, not in
  the path.
- A `-f` body is read and validated against the operation's request schema before anything is
  sent; an invalid body, a body for an operation that takes none, or a missing body the operation
  requires exits 2 with `INPUT_INVALID`.
- On success, `data` is the server's `data` and `meta` carries the server's `request_id` and
  `api_version` with the profile and Account. A server error keeps the server's `error.code`,
  message, and details, and exits with the code for its status ([Output and exit
  codes](output-and-exit-codes.md)).

```sh
pidgen api get /projects --query limit=10
pidgen api post /tickets/PIDGEN-4/retry/apply -f apply.yaml
```
