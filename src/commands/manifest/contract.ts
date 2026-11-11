import type { OpenApiDocument } from "../../core/input.js";
import { withReferences } from "../../core/references.js";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";

/**
 * The ticket-manifest routes and models, as the public API document publishes them
 * (docs/api-compatibility.md, "Ticket manifests"). Manifest files are checked against it before
 * anything is sent. The root and each child also take `references`, the Projects their reading runs
 * may read, which the server has agreed but not yet published (src/core/references.ts).
 */
export const MANIFEST_DOCUMENT: OpenApiDocument = withReferences(PUBLIC_API_DOCUMENT);

export const MANIFEST_PREVIEW_ROUTE = "/api/v1/ticket-manifests/preview";
export const MANIFEST_COMMIT_ROUTE = "/api/v1/ticket-manifests";
