# Authentication

For your first sign-in, follow [Get started with Pidgen](getting-started.md#2-sign-in).
This guide covers credentials, multiple Accounts, profiles, and automation.

## Credentials

| Credential | For | How you get it | Reach |
|---|---|---|---|
| **CLI token** (`pidgen_cli_…`) | People, and coding agents acting for them | `pidgen auth login` (device-code login) | Your current role in one Account |
| **Personal API Token** (`pidgen_pat_…`) | CI and headless automation | Created in the web UI | The token's scopes, capped by your role, in one Account |

Both are bound to **one Account**. A request that names a different Account is refused. Tokens
issued before the prefixes were renamed (`awes_cli_…`, `awes_pat_…`) are still recognised.

### Device-code login

```console
$ pidgen auth login https://pidgen.example.com
Open https://pidgen.example.com/device and enter the code  WDJB-MJHT
Waiting for approval…
```

1. The CLI confirms the server is Pidgen and that its API version range overlaps the CLI's
   ([API compatibility](api-compatibility.md)), before sending anything else.
2. It requests a device code and shows the verification address and a short user code.
3. You sign in to the web app, enter the code, choose the Account, and approve. Multi-factor
   authentication applies exactly as for a web sign-in.
4. The CLI polls until approval, verifies the new CLI token with `GET /me` (which must answer `200`),
   and only then stores it for that Account in the profile. The user
   code is shown only on standard error; the result on standard output reports the profile,
   server, Account and expiry, never the token. A denied login (`access_denied`) or an expired code
   (`expired_token`) exits 3 and stores nothing, and so does a token the server refuses when it is
   verified, such as `TOKEN_INVALID` ([details](commands.md#auth-login)).

Terminal stdout defaults to human-readable output; nonterminal stdout defaults to a JSON envelope.
Use `--format json` to request the envelope explicitly, or `--format table` for human-readable output.
Human responses label the login, local credential removal, revocation or selected Account outcome
and retain credential source, expiry, membership and verification information when supplied.
`auth status` retains the explanation when identity or server compatibility was not checked.
The verification address and user code stay on standard error in every format, and interactive
waiting progress also stays there. Refusals show their code, message and supplied recovery details.

A CLI token:

- carries your **current** role in its Account, so it can do what you can do there and no more;
- expires after 30 days without use, and after one year at most;
- appears among your signed-in devices in the web app and in `pidgen auth list`, and can be revoked
  from either place;
- is recorded in the audit log as your action `via` the CLI.

When your role changes, or your membership or Account is blocked or locked, the token follows at
once.

### Personal API Tokens

Use one when no person is present, such as in CI. Set it with `PIDGEN_TOKEN`, or store it in a profile
with `pidgen auth login https://pidgen.example.com --with-token --account ACC-… < token.txt`
([details](commands.md#auth-login---with-token)). Before storing it, the CLI verifies the token
with `GET /projects` in that Account (a Personal API Token is refused on `/me` by design): a wrong,
revoked or expired token (`TOKEN_INVALID`) or one bound to another Account (`ACCOUNT_MISMATCH`) is
refused with exit code 3 and nothing is written. A valid token without `tickets:read` is still
stored, and the login reports that limitation in `data.scope_limitation`.

Scopes limit what it can do even when your role allows more:

| Scope | Allows |
|---|---|
| `tickets:read` | Reading tickets and their artifacts |
| `tickets:create` | Creating tickets, Epics among them |
| `tickets:write` | Editing tickets, dependencies, Epic membership, clarification |
| `intents:create` | Submitting intents |
| `artifacts:upload` | Uploading artifacts |
| `plans:write` | Child plans and promotion |
| `runs:read`, `runs:control` | Reading runs; retry, replay and reopen |
| `workers:enroll` | Creating worker enrollments |

The first four scopes and `artifacts:upload` exist today; the rest are planned. The domain commands
need no scope of their own: `pidgen domain list` and `show` read with `tickets:read`, and every
domain write (create, edit, archive, projects, parents, members and maintainers) needs
`tickets:write`.

## Profiles and Accounts

### Switch Accounts

Check the Account in use and list your memberships:

```sh
pidgen auth status
pidgen account list
```

To select an Account with a stored credential:

```sh
pidgen account use ACC-EXAMPLE
```

Replace `ACC-EXAMPLE` with your Account's ID. If that Account has no stored credential, run
`pidgen auth login` and approve the login for it in your browser, then run `account use` again.
For one command, use `--account ACC-EXAMPLE` instead of changing the default.

### How profiles work

A **profile** is one Pidgen server. Within a profile the CLI stores one credential per Account and
remembers a default Account.

- `pidgen account list` shows the Accounts and marks the default. With a CLI token it lists every
  Account you belong to, from `GET /me`, merged with the Accounts that have a stored credential, and
  says which have one; with a Personal API Token (refused on `/me` by design) it lists the stored
  Accounts only, without a network call.
- `pidgen account use ACC-…` makes an Account with a stored credential the default; without one it
  exits 3 (`AUTH_REQUIRED`) and names the login command. Starting a device-code login instead is
  *planned*.
- `pidgen auth status` shows the profile, Account and credential in use. With a CLI token it also asks
  `GET /me` who you are and reports the User, the Account and your role there; with a Personal API
  Token it reports the local profile only, without a network call, and says that the server does
  not describe Personal API Tokens on `/me`.
- `pidgen auth logout [--account ACC-…]` forgets the stored credential and clears the default if it
  pointed there. It does not revoke the token on the server (*planned*, with
  `DELETE /me/sessions/{session_id}`); revoke a CLI token with `pidgen auth revoke <id>`, and a
  Personal API Token in the web app.
- `pidgen auth list` shows your browser sessions and CLI tokens (`GET /me/sessions`), with each one's
  id, device label, creation, last use and expiry, and marks the credential in use.
  `pidgen auth revoke <id>` revokes one at once (`DELETE /me/sessions/{session_id}`); when it is the
  credential in use, the CLI also removes it from the profile. Both need a CLI token: with a
  Personal API Token they exit 3 with `TOKEN_NOT_ALLOWED`, because Personal API Tokens are managed
  in the web app ([details](commands.md#auth-list)).
- `--account ACC-…` uses another stored credential for one command.

Skills never name an Account; they act in whatever Account the profile selects.

## Configuration file

`~/.config/pidgen/config.json` (or `$XDG_CONFIG_HOME/pidgen/config.json`), created with mode `0600`:

```json
{
  "default_profile": "default",
  "profiles": {
    "default": {
      "url": "https://pidgen.example.com",
      "default_account": "ACC-EXAMPLE",
      "server": { "service": "…", "api_version": { "current": "1.2", "minimum": "1.1" }, "checked_at": "…" },
      "credentials": {
        "ACC-EXAMPLE": { "kind": "cli", "token": "pidgen_cli_…", "token_id": "…", "expires_at": "…" }
      }
    }
  }
}
```

The CLI refuses to read the file if it is readable by other users. Operating-system keychain
storage is planned.

## Environment variables

| Variable | Overrides |
|---|---|
| `PIDGEN_PROFILE` | The profile to use |
| `PIDGEN_API_URL` | The profile's server URL |
| `PIDGEN_TOKEN` | The credential (a CLI token or Personal API Token) |
| `PIDGEN_ACCOUNT` | The Account, when the profile holds a credential for it |

The server is `PIDGEN_API_URL`, else the profile's `url`, else the hosted Pidgen server,
`https://api.pidgen.ai`. Only `pidgen auth login` writes the profile's `url`: with no `<url>` it
signs in to that same server, so on a fresh machine `pidgen auth login` signs in to the hosted one.
Give it a URL, or set `PIDGEN_API_URL`, to use another server.

A command that needs a credential and has none exits 3 with `AUTH_REQUIRED` before sending
anything.
