import type { Command } from "commander";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiResponse } from "../../core/http.js";
import { validateBody } from "../../core/input.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession, type Session } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";

export { subscriptionRows } from "../../core/lifecycle-human.js";

/** The read's `data`: the worker, whether it is connected, and each harness's subscriptions. */
type WorkerSubscriptions = components["schemas"]["WorkerSubscriptionsResource"];
type SetPrimaryRequest = components["schemas"]["MakePrimaryRequest"];
/** The change's `data`: its `outcome` (`applied` or `unknown`), the primary and active now. */
type CommandResult = components["schemas"]["PrimaryChangeResource"];

/** The operations these commands call, as the public API document names them. */
export const SUBSCRIPTIONS_ROUTE = {
  method: "get",
  path: "/workers/{host_id}/subscriptions",
} as const;
export const PRIMARY_ROUTE = {
  method: "put",
  path: "/workers/{host_id}/subscriptions/{harness}/primary",
} as const;

/**
 * The plain one-line explanation of each refusal of a subscription command, given the worker,
 * harness and label it named. The server's own wording is kept in `error.details.server_message`.
 */
const REFUSALS: Record<string, (target: Target) => string> = {
  ENTITLEMENT_LIMIT_REACHED: ({ worker }) =>
    `The Account's plan does not include multiple_subscriptions, so the App Service cannot switch ${worker}'s subscriptions; change the primary on the worker with pidgen-worker subscriptions use.`,
  SUBSCRIPTIONS_NOT_ENTITLED: ({ worker }) =>
    `Worker ${worker} refused: it has not been told the Account holds multiple_subscriptions, so it switches only on its own command (pidgen-worker subscriptions use).`,
  WORKER_OFFLINE: ({ worker }) =>
    `Worker ${worker} is not connected to the App Service, which does not queue commands; start the worker and run this again.`,
  SUBSCRIPTION_STALE: ({ worker, harness }) =>
    `Worker ${worker}'s ${harness ?? ""} primary changed while this command ran, so nothing was changed; run pidgen worker subscriptions ${worker} and try again.`,
  SUBSCRIPTION_UNAVAILABLE: ({ worker, harness, label }) =>
    `Worker ${worker} cannot use ${label ?? "that subscription"} for ${harness ?? "that harness"}: it is not declared, not logged in, or a duplicate login.`,
};

interface Target {
  worker: string;
  harness?: string;
  label?: string;
}

/**
 * `pidgen worker subscriptions <worker>`: one worker's provider subscriptions
 * (`GET /workers/{host_id}/subscriptions`). `<worker>` is its host id. `data` is the server's
 * `data` unchanged: whether the worker is connected and has advertised its subscriptions, and per
 * harness its `primary` and `active` subscription and each subscription's label, whether it is
 * the primary and the active one, login, entitlement, last login error, quota windows (each with
 * `observed_at`), and whether it is paused, with its pause windows and when the pause lifts. With
 * human output it prints labeled sections retaining the connection, login errors, quota
 * observations and pause windows alongside primary and active state.
 */
export const workerSubscriptions: CommandSpec = {
  path: ["worker", "subscriptions"],
  summary: "Show a worker's provider subscriptions; `use` makes one primary",
  configure(command: Command) {
    command.argument("<worker>", "the worker's host id, as pidgen worker status reports it");
  },
  async run(ctx, { args, global }) {
    const target: Target = { worker: requiredArgument("worker", args[0]) };
    const session = await openSession(ctx, global);
    const response = await readSubscriptions(session, target);
    return {
      data: response.data,
      meta: session.meta(response),
      presentation: { now: ctx.now() },
    };
  },
};

/**
 * `pidgen worker subscriptions use <worker> <harness> <label> [--move-continuing]`: reads the worker's
 * subscriptions, then sends `PUT /workers/{host_id}/subscriptions/{harness}/primary` with that
 * read's primary as `expected_primary`, so a change someone made meanwhile is refused
 * (`SUBSCRIPTION_STALE`) rather than overwritten. `data` is the change's result unchanged
 * (`outcome` `applied`, or `unknown` when the worker did not answer in time, with `detail`). Each refusal exits 5
 * with a one-line explanation. A harness the worker does not advertise exits 4 with
 * `HARNESS_NOT_ADVERTISED`, and nothing is sent. There is no preview: the route has none.
 */
export const workerSubscriptionsUse: CommandSpec = {
  path: ["worker", "subscriptions", "use"],
  summary: "Make one of a worker's subscriptions primary for a harness",
  configure(command: Command) {
    command
      .argument("<worker>", "the worker's host id")
      .argument("<harness>", "the harness, e.g. claude or codex")
      .argument("<label>", "the subscription's label in the worker's node.yaml")
      .option(
        "--move-continuing",
        "also move the worker's continuing steps of this harness to the new primary",
      );
  },
  async run(ctx, { args, options, global }) {
    const target = {
      worker: requiredArgument("worker", args[0]),
      harness: requiredArgument("harness", args[1]),
      label: requiredArgument("label", args[2]),
    };
    const move = options["moveContinuing"] === true;
    // Check the label before anything is sent; the expected primary is not known yet.
    requestBody(target, target.label, move);

    const session = await openSession(ctx, global);
    const read = await readSubscriptions(session, target);
    const harnesses = read.data.harnesses;
    const harness = harnesses.find((entry) => entry.harness === target.harness);
    if (harness === undefined) {
      throw new CliError(
        "HARNESS_NOT_ADVERTISED",
        `Worker ${target.worker} advertises no ${target.harness} harness.`,
        ExitCode.NotFound,
        { harness: target.harness, advertised: harnesses.map((entry) => entry.harness) },
      );
    }

    const body = requestBody(target, harness.primary, move);
    const response = await refusing(target, () =>
      session.client.request<CommandResult>({
        method: "PUT",
        path: `${workerPath(target.worker)}/subscriptions/${encodeURIComponent(target.harness)}/primary`,
        body,
      }),
    );
    return { data: response.data, meta: session.meta(response) };
  },
};

function requiredArgument(name: string, value: string | undefined): string {
  pathSegment(name, value);
  return (value as string).trim();
}

function workerPath(worker: string): string {
  return `/workers/${encodeURIComponent(worker)}`;
}

function requestBody(target: Target, expectedPrimary: string, move: boolean): SetPrimaryRequest {
  return validateBody(PUBLIC_API_DOCUMENT, PRIMARY_ROUTE.method, PRIMARY_ROUTE.path, {
    label: target.label,
    expected_primary: expectedPrimary,
    move_continuing_steps: move,
  }) as SetPrimaryRequest;
}

async function readSubscriptions(
  session: Session,
  target: Target,
): Promise<ApiResponse<WorkerSubscriptions>> {
  return refusing(target, () =>
    session.client.request<WorkerSubscriptions>({
      method: "GET",
      path: `${workerPath(target.worker)}/subscriptions`,
    }),
  );
}

/** Runs `call`, turning a subscription refusal into its one-line explanation (exit code 5). */
async function refusing<T>(target: Target, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const explain = REFUSALS[error.code];
    if (explain === undefined) throw error;
    throw new CliError(error.code, explain(target), ExitCode.Refused, {
      ...error.details,
      server_message: error.message,
    });
  }
}
