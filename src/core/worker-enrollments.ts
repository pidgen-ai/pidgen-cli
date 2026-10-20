import pending from "../../contracts/pending/worker-enrollments.json" with { type: "json" };
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiClient, ApiResponse } from "./http.js";
import { validateBody, type OpenApiDocument } from "./input.js";
import type { components } from "../generated/worker-enrollments.js";

/**
 * Worker enrollments with this install's id, and withdrawing one: `install_id` on
 * `POST /api/v1/workers/enrollments` and on each worker `GET /api/v1/workers` lists, and
 * `DELETE /api/v1/workers/enrollments/{enrollment_id}`.
 *
 * The App Service has agreed these but not yet published them, so the CLI is built against a
 * pending fragment, `contracts/pending/worker-enrollments.json`, its types generated from it and
 * the enrollment request validated against it. When the server publishes them they are pulled with
 * `contracts/openapi.json` and the fragment is deleted.
 */

export type CreateEnrollmentRequest = components["schemas"]["CreateEnrollmentRequest"];
export type CreatedEnrollment = components["schemas"]["CreatedEnrollment"];
export type WorkerEnrollment = components["schemas"]["WorkerEnrollment"];
export type WorkerList = components["schemas"]["WorkerList"];
export type WorkerResource = components["schemas"]["WorkerResource"];

/** The pending fragment, bundled into the CLI at build time. */
export const WORKER_ENROLLMENTS_DOCUMENT: OpenApiDocument = pending;

/** The enrollment create, as the fragment names it. */
export const ENROLL_ROUTE = { method: "post", path: "/workers/enrollments" } as const;

/** The withdraw, as the fragment names it. */
export const WITHDRAW_ROUTE = {
  method: "delete",
  path: "/workers/enrollments/{enrollment_id}",
} as const;

/** The created enrollment, and the install id the server took with it (`null`: none was sent). */
export interface Created {
  response: ApiResponse<CreatedEnrollment>;
  installId: string | null;
}

/**
 * Creates an enrollment with `body` and, when there is one, this install's id as `install_id`. A
 * server from before install ids refuses the field (HTTP 422 naming `install_id`): the create is
 * sent once more without it, and `installId` is then `null`. `note` hears why.
 */
export async function createEnrollment(
  client: ApiClient,
  body: Omit<CreateEnrollmentRequest, "install_id">,
  installId: string | null,
  note: (text: string) => void,
): Promise<Created> {
  const send = (request: CreateEnrollmentRequest) =>
    client.request<CreatedEnrollment>({
      method: "POST",
      path: ENROLL_ROUTE.path,
      body: validateBody(
        WORKER_ENROLLMENTS_DOCUMENT,
        ENROLL_ROUTE.method,
        ENROLL_ROUTE.path,
        request,
      ),
    });
  if (installId === null) return { response: await send(body), installId: null };
  try {
    return { response: await send({ ...body, install_id: installId }), installId };
  } catch (error) {
    if (!refusesInstallId(error)) throw error;
    note("The server does not take an install id yet; creating the enrollment without it.\n");
    return { response: await send(body), installId: null };
  }
}

/** Whether `error` is the server's 422 refusal of the `install_id` field. */
export function refusesInstallId(error: unknown): boolean {
  if (!(error instanceof CliError) || error.details["status"] !== 422) return false;
  return `${error.message} ${JSON.stringify(error.details)}`.includes("install_id");
}

/** What withdrawing an enrollment came to: done, or the error that kept it. */
export type Withdrawal = { withdrawn: true } | { withdrawn: false; error: CliError };

/**
 * Withdraws the caller's pending enrollment `enrollmentId`
 * (`DELETE /workers/enrollments/{enrollment_id}`), so it does not wait for 24 hours holding a
 * worker slot. Never throws: a refusal or a network failure is returned.
 */
export async function withdrawEnrollment(
  client: ApiClient,
  enrollmentId: string,
): Promise<Withdrawal> {
  try {
    await client.request({
      method: "DELETE",
      path: WITHDRAW_ROUTE.path.replace("{enrollment_id}", encodeURIComponent(enrollmentId)),
    });
    return { withdrawn: true };
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError(
            "CLI_INTERNAL",
            error instanceof Error ? error.message : String(error),
            ExitCode.Unexpected,
          );
    return { withdrawn: false, error: failure };
  }
}
