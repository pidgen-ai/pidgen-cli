# Architecture

## What the CLI is

`pidgen` is the end user's terminal and agent interface to the Pidgen App Service. It is:

- **A client of the public API only.** Every command is one or more HTTPS calls to routes listed in
  the App Service's public API document ([API compatibility](api-compatibility.md)). The CLI never
  reads a database, server files, or worker configuration.
- **For people and agents.** Terminal stdout defaults to human-readable output; nonterminal stdout
  defaults to JSON. `--format json` and `--format table` override selection. JSON envelopes and exit
  codes are stable, and anything with side effects previews before it applies.
  The one interactive command is `pidgen setup`, the guided path for a person at a terminal; it
  is composed of the scriptable commands, shows one line per action, and records each command it
  runs, with its output, in a setup log (`--verbose` shows them as they run).
- **The home of the Pidgen agent skills.** The agent skills are bundled in the npm package and
  installed into an agent's skill directory with `pidgen skills install` ([Skills](skills.md)).
- **The front door for workers.** `pidgen worker` installs and verifies a worker, enrolls it, and
  delegates to the separately distributed `pidgen-worker` to run it ([Workers](workers.md)).

It is open source (Apache-2.0). The App Service and the worker are not.

Pidgen is the product name, and every identifier the CLI shares with the App Service and the
worker uses it: the `service: pidgen` health identity, the `PIDGEN-API-Version` and
`X-PIDGEN-Account` headers, `PIDGEN_*` environment variables, the `pidgen` configuration
directory, skill stamp fields, the token prefixes (`pidgen_cli_`, `pidgen_pat_`) and the
`pidgen-worker` program. Tokens issued before the prefixes were renamed (`awes_cli_`, `awes_pat_`)
are still recognised.

## Where it sits

```text
┌──────────────────────────────┐        HTTPS, public API         ┌──────────────────────────┐
│ End user's machine           │  ─────────────────────────────▶  │ Pidgen App Service        │
│                              │   CLI token / Personal API Token │                          │
│  person or coding agent      │   PIDGEN-API-Version: 1.x          │                          │
│        │                     │                                  │                          │
│        ▼                     │                                  │                          │
│  pidgen (this repository)    │                                  │                          │
│        │ pidgen worker …     │                                  │                          │
│        ▼                     │        worker protocol           │                          │
│  pidgen-worker (separate)  ────┼────── credential ─────────────▶  │                          │
└──────────────────────────────┘                                  └──────────────────────────┘
```

Two principals, two credentials:

- The **CLI** acts as a person, with a CLI token from device-code login or a Personal API Token.
  The credential is bound to one Pidgen Account ([Authentication](authentication.md)).
- The **worker** connects with a credential it obtains itself during enrollment. The CLI
  never stores that credential, and the worker never receives a human credential.

Keeping them apart matters because the worker runs autonomous agent sessions on the same machine.
A human credential beside the worker would let a run act on its own ticket.

## What the CLI is not

- Not an admin console for the Pidgen platform. Platform-operator routes are not in the public API,
  and platform-operator skills are a separate private pack.
- Not a wrapper around the database or around server repositories. A capability the API lacks is
  added to the API, not worked around in the CLI or a skill.
- Not a distribution channel for the worker. The server's release list names the worker releases it
  accepts, and the CLI installs one only after verifying it was signed by the worker's release
  workflow; the CLI does not bundle or pin it.

## Design principles

1. **Public API only.** If a command needs something the public API does not offer, the fix is a
   new public route, not a workaround.
2. **One JSON envelope, stable codes.** JSON mode uses the same envelope and maps failures onto the
   same exit codes. Human mode presents those results without changing execution. Help/version print
   text; foreground `worker start` inherits the worker's streams and status
   ([Output and exit codes](output-and-exit-codes.md)).
3. **No surprises for agents.** No prompts outside `pidgen setup`, no implicit acknowledgements, no
   apply without a digest the caller has seen ([Preview and apply](preview-and-apply.md)).
4. **Nothing private in this repository.** No server internals, private hostnames, internal paths,
   or credentials in code, docs, fixtures, or skills.
5. **Small and fast.** Minimal dependencies and a single bundled file, so `npx pidgen` starts
   quickly.
