import published from "../../contracts/openapi.json" with { type: "json" };
import { schemaIssues, type InputIssue, type OpenApiDocument } from "../../src/core/input.js";
import type { components } from "../../src/generated/api.js";

/**
 * Fixtures for the domain, Domain Epic, contract, ticket contract and worker release commands,
 * shaped by the published document (`contracts/openapi.json`). The document states these routes
 * with schemas but no examples, so the fixtures are written here, typed from the generated types,
 * and every test that uses one also checks it against its published schema (`publishedIssues`).
 * Nothing here comes from a live server.
 */

type Schemas = components["schemas"];

export const PUBLISHED: OpenApiDocument = published;

/** Every issue `value` has against the published schema `name`; empty when it matches. */
export function publishedIssues(name: keyof Schemas, value: unknown): InputIssue[] {
  return schemaIssues(PUBLISHED, { $ref: `#/components/schemas/${name}` }, value);
}

/** A refusal body in the public error shape (`PublicError`). */
export function publicError(
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): Schemas["PublicError"] {
  return { status: "error", error: { code, message, details, request_id: "req_example" } };
}

// Domains -------------------------------------------------------------------------------------

export const DOMAIN_IDS = {
  root: "DOM-00000000000000000000000000000001",
  pay: "DOM-00000000000000000000000000000002",
  fin: "DOM-00000000000000000000000000000003",
  cards: "DOM-00000000000000000000000000000004",
} as const;

/** A person's user id, as the published people routes take it (a UUID). */
export const USER_ID = "00000000-0000-4000-8000-000000000007";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000009";

const STAMPS = { created_at: "2026-09-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z" };

export const DOMAIN_ROOT: Schemas["DomainResource"] = {
  id: DOMAIN_IDS.root,
  key: "EXMPL",
  name: "Example",
  is_account_root: true,
  archived: false,
  archived_at: null,
  parents: [],
  projects: ["proj-example-a", "proj-example-b", "proj-example-c"],
  domains: [DOMAIN_IDS.pay, DOMAIN_IDS.fin],
  people: { members: 0, maintainers: 2 },
  epics: { open: 0, total: 0 },
  version: 1,
  ...STAMPS,
};

export const DOMAIN_PAY: Schemas["DomainResource"] = {
  id: DOMAIN_IDS.pay,
  key: "PAY",
  name: "Payments",
  is_account_root: false,
  archived: false,
  archived_at: null,
  parents: [DOMAIN_IDS.root],
  projects: ["proj-example-a", "proj-example-b"],
  domains: [DOMAIN_IDS.cards],
  people: { members: 3, maintainers: 1 },
  epics: { open: 1, total: 4 },
  version: 3,
  ...STAMPS,
};

/** `GET /domains`: the domains the caller may read, the Account domain first. */
export const DOMAIN_LIST: Schemas["DomainResource"][] = [DOMAIN_ROOT, DOMAIN_PAY];

/** One domain as a read or a write answers it: the resource and the people granted on it. */
export const DOMAIN_DETAIL: Schemas["DomainDetail"] = {
  ...DOMAIN_PAY,
  granted: [
    { user_id: USER_ID, role: "maintainer" },
    { user_id: OTHER_USER_ID, role: "member" },
  ],
};

// Tickets and Domain Epics ----------------------------------------------------------------------

/** A Ticket as the published `TicketResource` states it; `overrides` set its own fields. */
export function ticket(
  overrides: Partial<Schemas["TicketResource"]> = {},
): Schemas["TicketResource"] {
  return {
    team_member: { id: "", display_name: "", status: "" },
    is_high_level: false,
    is_composition_parent: false,
    backlog_disposition: null,
    backlog_readiness: null,
    execution_admitted: false,
    waiting_for_parent_admission: false,
    waiting_for_descendants: false,
    high_level_parent_id: null,
    ready_for_scheduler: false,
    readiness_blockers: [],
    admission_blocker: null,
    account_pool_wait: null,
    queued_refinement_start: null,
    account_stop: null,
    worker_admission_block: null,
    live_run_hold: null,
    cohort_progress: {},
    domain_epic: null,
    status: null,
    activity: null,
    id: "TKT-example-alpha-40",
    ticket_key: "ALPHA-40",
    account_id: "ACC-EXAMPLE",
    project_id: "proj-example-a",
    team_member_id: null,
    version: 1,
    ticket_number: 40,
    epic_id: null,
    parent_ticket_id: null,
    kind: "story",
    target_date: null,
    branch_mode: null,
    feature_branch: null,
    feature_branch_cut_at: null,
    feature_branch_cut_error: null,
    stage: "backlog",
    execution_admission_digest: null,
    execution_admitted_at: null,
    execution_admitted_by: null,
    materialized_plan_digest: null,
    approval_mode: "manual",
    merge_policy: null,
    workflow_type: "implementation",
    priority: 5,
    priority_level: 0,
    list_position: null,
    title: "Charge a saved card",
    objective: "Charge a card the customer saved.",
    scope_boundaries: null,
    acceptance_criteria: [],
    success_metrics: [],
    context_artifacts: [],
    assumptions: [],
    open_questions: [],
    created_at: "2026-10-01T09:00:00Z",
    source: "api",
    source_id: null,
    source_user: null,
    owner_user_id: null,
    required_capabilities: [],
    estimated_complexity: null,
    stage_history: [],
    intervention_history: [],
    change_summaries: [],
    prompt_overrides: {},
    prompt_overrides_digest: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    target_lane: "backlog",
    auto_promotion_status: null,
    auto_promotion_reason: null,
    tags: [],
    usage_flags: [],
    ...overrides,
  } as Schemas["TicketResource"];
}

const DOMAIN_EPIC_FIELDS = {
  team_member_id: "AGENT-EXAMPLE-UNASSIGNED",
  ticket_number: 12,
  kind: "epic",
  branch_mode: "project_base",
  workflow_type: "epic-delivery",
  title: "Checkout across payments and cards",
  objective: "One checkout across the payment and card projects.",
} as const;

/** `POST /tickets` with `domain_id`: the Domain Epic, filed in the domain's home. */
export const DOMAIN_EPIC_CREATED: Schemas["CreatedTicket"] = {
  ...ticket({
    ...DOMAIN_EPIC_FIELDS,
    id: "TKT-example-com-12",
    ticket_key: "COM-12",
    project_id: "proj-example-com-home",
  }),
  refinement_command_id: null,
  command_error: null,
};

const PAY_EPIC = ticket({
  ...DOMAIN_EPIC_FIELDS,
  id: "TKT-example-pay-12",
  ticket_key: "PAY-12",
  project_id: "proj-example-pay-home",
});

const EPIC_REF = { key: "PAY-12", title: DOMAIN_EPIC_FIELDS.title };

/** `GET /domains/{domain_id}/epics`: one open Domain Epic with work in two projects. */
export const DOMAIN_EPIC_BOARD: Schemas["DomainEpicBoard"] = {
  epics: [
    {
      epic: PAY_EPIC,
      domain_id: DOMAIN_IDS.pay,
      projects: [
        {
          project: { id: "proj-example-a", key: "ALPHA", name: "Alpha" },
          ticket_ids: ["TKT-example-alpha-40"],
        },
        {
          project: { id: "proj-example-b", key: "BETA", name: "Beta" },
          ticket_ids: ["TKT-example-beta-7"],
        },
      ],
      hidden: 2,
    },
  ],
  tickets: [
    ticket({
      epic_id: PAY_EPIC.id,
      parent_ticket_id: PAY_EPIC.id,
      domain_epic: EPIC_REF,
    }),
    ticket({
      id: "TKT-example-beta-7",
      ticket_key: "BETA-7",
      project_id: "proj-example-b",
      ticket_number: 7,
      kind: "task",
      epic_id: PAY_EPIC.id,
      parent_ticket_id: PAY_EPIC.id,
      domain_epic: EPIC_REF,
      title: "Save a card at checkout",
      objective: "Let a customer save a card while paying.",
    }),
  ],
  running: 1,
};

// Contracts -------------------------------------------------------------------------------------

type Provider = Schemas["ContractProvider"];

export const ALPHA_PROVIDER: Provider = {
  project_id: "proj-example-a",
  kind: "project",
  domain_id: null,
  key: "ALPHA",
  name: "Alpha",
};
export const BETA_PROVIDER: Provider = {
  project_id: "proj-example-b",
  kind: "project",
  domain_id: null,
  key: "BETA",
  name: "Beta",
};
export const GAMMA_PROVIDER: Provider = {
  project_id: "proj-example-c",
  kind: "project",
  domain_id: null,
  key: "GAMMA",
  name: "Gamma",
};
/** A domain's contract: the domain provides it, and its home project holds it. */
export const PAY_PROVIDER: Provider = {
  project_id: "proj-example-pay-home",
  kind: "domain",
  domain_id: DOMAIN_IDS.pay,
  key: "PAY",
  name: "Payments",
};

/** A list entry: the contract without its revisions or linked work. */
export function contractSummary(
  overrides: Partial<Schemas["ContractSummaryResource"]> = {},
): Schemas["ContractSummaryResource"] {
  return {
    id: "CTR-example-7",
    key: "CT-7",
    number: 7,
    title: "Payments API",
    status: "accepted",
    provider: ALPHA_PROVIDER,
    owner_user_id: USER_ID,
    replacement_contract_id: null,
    replacement: null,
    newest_accepted_revision: 2,
    waiting_revisions: [3],
    kind: "rest",
    implemented: true,
    tracked_paths: [],
    version: 4,
    ...STAMPS,
    ...overrides,
  };
}

const LEDGER = contractSummary({
  id: "CTR-example-4",
  key: "CT-4",
  number: 4,
  title: "Ledger library",
  provider: GAMMA_PROVIDER,
  owner_user_id: OTHER_USER_ID,
  newest_accepted_revision: 1,
  waiting_revisions: [],
  kind: "library",
});

/** `GET /projects/{project_ref}/contracts`: what the project provides and builds against. */
export const PROJECT_CONTRACTS: Schemas["ProjectContractsResource"] = {
  provides: [contractSummary()],
  builds_against: [LEDGER],
};

/** `GET /domains/{domain_id}/contracts`: its own, its coverage's by provider, and builds-against. */
export const DOMAIN_CONTRACTS: Schemas["DomainContractsResource"] = {
  own: [
    contractSummary({
      id: "CTR-example-9",
      key: "CT-9",
      number: 9,
      title: "Settlement events",
      status: "draft",
      provider: PAY_PROVIDER,
      newest_accepted_revision: null,
      waiting_revisions: [1],
      kind: "events",
      implemented: false,
    }),
  ],
  coverage: [
    { provider: ALPHA_PROVIDER, contracts: [contractSummary()] },
    {
      provider: BETA_PROVIDER,
      contracts: [
        contractSummary({
          id: "CTR-example-12",
          key: "CT-12",
          number: 12,
          title: "Card tokens",
          provider: BETA_PROVIDER,
          owner_user_id: null,
          newest_accepted_revision: 1,
          waiting_revisions: [],
          implemented: false,
        }),
      ],
    },
  ],
  builds_against: [LEDGER],
};

type Revision = Schemas["ContractRevisionResource"];

/** One revision of CT-7; `overrides` set its own fields. */
export function revision(number: number, overrides: Partial<Revision> = {}): Revision {
  return {
    number,
    kind: "rest",
    markdown: `# Payments API\n\nRevision ${number}.\n`,
    native_schema: `openapi: 3.1.0\ninfo:\n  title: Payments\n  version: '${number}'\npaths: {}\n`,
    schema_format: "openapi",
    change: number === 1 ? "additive" : "breaking",
    operations: [{ name: "GET /payments" }, { name: "POST /payments", types: ["Payment"] }],
    defined_by_ticket_id: null,
    acceptance: "automatic",
    accepted_by: null,
    accepted_at: `2026-09-0${number}T10:00:00Z`,
    read_at_commit: null,
    created_at: `2026-09-0${number}T09:00:00Z`,
    created_by: USER_ID,
    ...overrides,
  };
}

/** `GET /contracts/{contract_id}`: CT-7 with an automatic, a person's and a waiting revision. */
export const CONTRACT: Schemas["ContractDetail"] = {
  ...contractSummary(),
  revisions: [
    revision(1),
    revision(2, { acceptance: "person", accepted_by: OTHER_USER_ID }),
    revision(3, { acceptance: "waiting", accepted_by: null, accepted_at: null }),
  ],
  implemented_by: {
    work: [
      {
        ticket_id: "TKT-example-40",
        ticket_key: "ALPHA-40",
        title: "Refunds",
        stage: "in_execution",
        project_id: "proj-example-a",
        operations: ["POST /payments"],
      },
    ],
    hidden_count: 0,
  },
  built_against_by: {
    work: [
      {
        ticket_id: "TKT-example-12",
        ticket_key: "BETA-12",
        title: "Checkout pays by card",
        stage: "backlog",
        project_id: "proj-example-b",
        operations: [],
      },
    ],
    hidden_count: 2,
  },
  tracking: null,
  may_revise: true,
  may_accept: true,
};

/** CT-7 after `revise`: a fourth revision, accepted at once. */
export const REVISED: Schemas["ContractDetail"] = {
  ...CONTRACT,
  newest_accepted_revision: 4,
  revisions: [...CONTRACT.revisions, revision(4, { change: "additive" })],
  version: 5,
};

/** CT-7 after `accept` of revision 3: accepted by a person. */
export const ACCEPTED: Schemas["ContractDetail"] = {
  ...CONTRACT,
  newest_accepted_revision: 3,
  waiting_revisions: [],
  revisions: CONTRACT.revisions.map((entry) =>
    entry.number === 3
      ? {
          ...entry,
          acceptance: "person",
          accepted_by: USER_ID,
          accepted_at: "2026-10-14T09:00:00Z",
        }
      : entry,
  ),
  version: 5,
};

/** One of a Ticket's contract links. */
export function contractLink(
  overrides: Partial<Schemas["TicketContractResource"]> = {},
): Schemas["TicketContractResource"] {
  return {
    contract_id: "CTR-example-7",
    key: "CT-7",
    title: "Payments API",
    status: "accepted",
    provider_project_id: "proj-example-a",
    link: "implements",
    operations: [],
    criterion_id: "AC-example-implements-ct-7",
    linked_at: "2026-10-14T09:10:00Z",
    linked_by: USER_ID,
    ...overrides,
  };
}

// Contract publishing ---------------------------------------------------------------------------

/** A publish of contracts/payments/openapi.yaml: the first one, which created CT-12. */
export const PUBLISHED_CREATED: Schemas["ContractPublishResult"] = {
  outcome: "created",
  dry_run: false,
  contract_id: "CTR-0123456789abcdef0123456789abcdef",
  contract_key: "CT-12",
  revision: 1,
  acceptance: "automatic",
  change: "additive",
  change_reason: "The first published revision.",
  format: "openapi",
  version: "3.1.0",
  title: "Payments API",
  source_path: "contracts/payments/openapi.yaml",
  operation_count: 2,
  type_count: 1,
  added: ["GET /payments", "createPayment"],
  removed: [],
  types_added: ["Payment"],
  types_removed: [],
  landed: [],
  still_pending: [],
  resolved_refusals: [],
};

/** A later publish that added an operation, landing one pending operation and not another. */
export const PUBLISHED_REVISED: Schemas["ContractPublishResult"] = {
  ...PUBLISHED_CREATED,
  outcome: "revised",
  revision: 4,
  change_reason: "Adds the operation POST /payments/{id}/void.",
  operation_count: 3,
  added: ["POST /payments/{id}/void"],
  types_added: [],
  landed: ["POST /payments/{id}/void"],
  still_pending: ["POST /payments/{id}/refund"],
};

/** The same interface again: nothing was recorded. */
export const PUBLISHED_UNCHANGED: Schemas["ContractPublishResult"] = {
  ...PUBLISHED_CREATED,
  outcome: "unchanged",
  revision: 4,
  acceptance: null,
  change: null,
  change_reason: "",
  operation_count: 3,
  added: [],
  types_added: [],
};

/** A dry run of a publish that would remove an operation and a type. */
export const DRY_RUN_BREAKING: Schemas["ContractPublishResult"] = {
  ...PUBLISHED_CREATED,
  outcome: "revised",
  dry_run: true,
  revision: 5,
  acceptance: null,
  change: "breaking",
  change_reason: "Removes the operation DELETE /payments/{id} and the type LegacyPayment.",
  operation_count: 2,
  added: [],
  removed: ["DELETE /payments/{id}"],
  types_added: [],
  types_removed: ["LegacyPayment"],
};

/** A dry run of a publish that would add an operation. */
export const DRY_RUN_ADDITIVE: Schemas["ContractPublishResult"] = {
  ...PUBLISHED_REVISED,
  dry_run: true,
  acceptance: null,
};

/** A proposal from a fragment: one operation made pending, one already landed. */
export const PROPOSED: Schemas["ContractProposalResult"] = {
  dry_run: false,
  contract_id: "CTR-0123456789abcdef0123456789abcdef",
  contract_key: "CT-12",
  revision: 5,
  acceptance: "automatic",
  format: "openapi",
  version: "3.1.0",
  title: "Payments API",
  operations: ["GET /payments", "POST /payments/{id}/refund"],
  pending: ["POST /payments/{id}/refund"],
  landed: ["GET /payments"],
};

// Worker releases -------------------------------------------------------------------------------

/** The worker licence the release list names. */
export const WORKER_EULA: Schemas["WorkerEula"] = {
  name: "Pidgen Worker End-User Licence Agreement",
  location: "Ships inside the pidgen-worker container image and the PyPI wheel.",
  notice:
    "The Pidgen worker is proprietary software licensed under the Pidgen Worker End-User Licence Agreement. Installing it accepts that agreement.",
};
