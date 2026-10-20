# Use a new model on a worker

A new model needs support at three levels: your provider account and coding agent, the worker
that launches that agent, and the model selection for your work in Pidgen. Updating one does not
prove that the other two are ready. This guide covers the worker side, including Claude's
executable override and image-input declarations.

The policy examples below are verified against the schema and annotated policy example in the
public [pidgen-worker 2.11.1 release](https://pypi.org/project/pidgen-worker/2.11.1/). Check your
installed worker version before using them. See [Worker policy](worker-policy.md) for the exact
keys, constraints and defaults; do not copy these settings into `node.yaml`.

## Check what is installed

Run these on the worker's machine, as the user that runs it, with the same worker home and
environment. For a service or container, your interactive shell may use different executables
or logins.

```console
pidgen --version
pidgen doctor --format json
pidgen worker status --format json
pidgen worker doctor --format json
```

Read the worker version in `data.update.installed`, failed doctor checks, and status warnings.
`data.running` and a successful doctor are local readiness evidence; check
`data.server.worker.connected` when the server view is available. An absent server view does not
prove connection or enrollment failure. See [Troubleshooting](troubleshooting.md).

Identify the provider, exact model ID and harness you want to use. Check the provider's official
model documentation and the harness's release notes for support and account access. A model alias
may change what it selects, so use an explicit ID when you need a reproducible check.

If Pidgen reports that a worker update is required, follow [Update the worker](workers.md#update-the-worker).
Use the server's accepted releases and the CLI's verification; installing an arbitrary release
or re-enrolling does not add model support.

## Use a newer Claude executable

For worker 2.11.1, Claude normally uses the CLI bundled with its SDK. Updating the `claude` command
on your shell's `PATH` alone does not select that executable for worker turns. When the bundled
CLI lacks support for a model, install a compatible Claude Code executable using the provider's
documented installation procedure and verify its version as the worker's user.

Then merge this setting into the existing worker policy, replacing the example path with the
absolute path of that executable:

```yaml
harnesses:
  claude:
    cli_path: /opt/example-tools/claude
```

Keep the existing options and other harnesses. The path must name an executable launcher, not a
directory or an inferred script invocation. Set `cli_path` to `null` or remove that key to return
to the bundled CLI. This changes which executable runs; it neither grants model access nor
selects a model for a ticket.

For Pi, `harnesses.pi.cli_path` can select an executable launcher outside the worker's `PATH`.
Codex has different binary-policy controls; it has no `cli_path` key in this policy schema. See
[Codex options](worker-policy.md#codex-options) before changing its runtime.

## Declare image support for an unfamiliar model

Claude and Codex policy can extend or override the worker's known model input capabilities.
Confirm those capabilities in the provider's documentation first. An entry describes what a
model accepts; it does not make a text-only model accept images or register a model in Pidgen.

For example, merge this into the existing Claude policy only after replacing the placeholder
with a verified model ID:

```yaml
harnesses:
  claude:
    vision:
      model_modalities:
        example-model-id: [text, image]
```

Codex uses the same structure under `harnesses.codex.vision`. Preserve existing entries. To choose
a vision fallback, set `vision.fallback_model` to an accessible model that accepts images in the
merged capability table. A `null` fallback keeps the shipped fallback; it does not disable it.
The worker can select a fallback for image-bearing input, so verify which model actually ran.
If no usable image model is available, `HARNESS_IMAGE_INPUT_UNAVAILABLE` is a readiness failure,
not a reason to assert unsupported capabilities.

Pi uses the model's declared metadata rather than this capability table. Its optional vision
fallback uses both `harnesses.pi.vision.fallback_provider` and `fallback_model`; confirm the
fallback's image support through the provider and Pi.

## Apply and verify

Follow [Change and verify policy](worker-policy.md#change-and-verify-policy): preserve the prior
values, validate, and restart through the existing launch method. Keep the requested harness's
session cap above zero and verify its login with the worker doctor. Adding an executable or a
model capability declaration does not enable a disabled harness.

Select the model through the controls available to your Account in Pidgen. The CLI currently has
no general model catalog create/update command. A ticket's `team_member_id` selects an Account
Agent by ID, not a model ID. If the model is not offered, ask your Account administrator or Pidgen
support to confirm availability and selection. Do not use an unpublished API or invent a worker
configuration key to bypass that step.

For an execution check, use an authorized, small task and inspect the resulting session's model
and outcome in Pidgen. A successful login, saved policy, green doctor, or capacity change alone
does not prove that the new model ran. Record the worker and harness versions and whether an
image fallback was used. If the session does not expose enough evidence, report execution as
unverified rather than assuming success.

If it fails, retain the error code and a short redacted excerpt. Revert only the settings you
changed if needed, validate, and restart using the same method. See
[Get help](troubleshooting.md#get-help); feedback sends immediately, so review its contents first.
