import type { OpenApiDocument } from "../../core/input.js";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";

/**
 * The ticket-manifest routes and models, as the public API document publishes them
 * (docs/api-compatibility.md, "Ticket manifests"). Manifest files are checked against it before
 * anything is sent.
 */
export const MANIFEST_DOCUMENT: OpenApiDocument = PUBLIC_API_DOCUMENT;

export const MANIFEST_PREVIEW_ROUTE = "/api/v1/ticket-manifests/preview";
export const MANIFEST_COMMIT_ROUTE = "/api/v1/ticket-manifests";
