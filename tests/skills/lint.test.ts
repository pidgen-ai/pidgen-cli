import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLIC_API_DOCUMENT } from "../../src/commands/api/document.js";
import { PREVIEW_TEMPLATE } from "../../src/commands/plan/apply.js";
import { commands } from "../../src/commands/index.js";
import {
  MANIFEST_DOCUMENT,
  MANIFEST_PREVIEW_ROUTE,
} from "../../src/commands/manifest/contract.js";
import { FILE_REFUSALS } from "../../src/core/contract-publish.js";
import { validateBody } from "../../src/core/input.js";
import { commandName, NOUNS } from "../../src/core/registry.js";
import { REPO_SKILLS_DIR } from "../support/context.js";

/**
 * The skill lint. See CONTRIBUTING.md, "Rules for skill content".
 * Skills listed in imported.json are exempt from the content rules until they are ported.
 */

const imported: string[] = JSON.parse(
  readFileSync(new URL("./imported.json", import.meta.url), "utf8"),
);

const skillNames = readdirSync(REPO_SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const FORBIDDEN: [RegExp, string][] = [
  [/\bcurl\b|\bwget\b/, "calls HTTP directly; use a pidgen command"],
  [/\bpsql\b|docker exec|postgres(?:ql)?:\/\//i, "touches a database"],
  [/\/api\/v\d+\//, "names a raw API path"],
  [/\blocalhost\b|127\.0\.0\.1/, "names a local server"],
  [/\/home\/[a-z]|\/Users\/[A-Za-z]|~\/projects\//, "names a local path"],
  [/\.venv\/|(?:^|[`$]\s?)make [a-z-]+/m, "runs repository tooling"],
  [/\bACC-[A-Z0-9]{6,}\b/, "hardcodes an Account id"],
];

// A skill names `pidgen <noun> <verb>`; for a grouped command such as `pidgen epic edge add` the
// lint checks `<noun> <group>` exists, so both the full name and its first two words are known.
const known = new Set(commands.flatMap((spec) => [commandName(spec), spec.path.slice(0, 2).join(" ")]));

function frontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) return {};
  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

describe("imported.json", () => {
  // Empty once every skill is ported; any name it lists must still be a bundled skill.
  it("lists only skills that exist", () => {
    for (const name of imported) expect(skillNames).toContain(name);
  });
});

describe.each(skillNames)("skill %s", (name) => {
  const file = join(REPO_SKILLS_DIR, name, "SKILL.md");
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";

  it("has a SKILL.md with a matching name and a description", () => {
    expect(content, "missing SKILL.md").not.toBe("");
    const fields = frontmatter(content);
    expect(fields["name"]).toBe(name);
    expect(fields["description"]?.length ?? 0).toBeGreaterThan(20);
  });

  it("uses LF line endings", () => {
    expect(content.includes("\r\n")).toBe(false);
  });

  it.skipIf(imported.includes(name))("contains nothing forbidden", () => {
    for (const [pattern, reason] of FORBIDDEN) {
      expect(pattern.test(content), `${name} ${reason} (${pattern})`).toBe(false);
    }
  });

  // AC-5efa3f4c781e: instructions must be independent of their caller's terminal.
  it.skipIf(imported.includes(name))("explicitly selects JSON in structured command examples", () => {
    const fragments = content.split(/(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*(?=\n|$))/m);
    const examples = fragments.flatMap((fragment) => /^\s*```/.test(fragment)
      ? fragment.replace(/\\\n\s*/g, " ").split("\n")
      : [...fragment.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
    );
    const invocations = examples.filter((line) => /\bpidgen [a-z]/.test(line));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line, `${name}: ${line}`).toMatch(/--format(?:=| )json\b/);
    }
  });

  it.skipIf(imported.includes(name))("names only commands that exist", () => {
    const nouns = Object.keys(NOUNS).join("|");
    const invocations = content.matchAll(new RegExp(`\\bpidgen (${nouns}) ([a-z][a-z-]*)`, "g"));
    for (const [, noun, verb] of invocations) {
      expect(known.has(`${noun} ${verb}`), `pidgen ${noun} ${verb} is not a command`).toBe(true);
    }
  });
});

/**
 * Recovery and replay go through `pidgen ticket actions` and `pidgen ticket act`. No bundled skill or
 * doc sends a user to the internal admin recovery routes with a mode, and none describes an
 * attention finding's `action` field, which the published finding does not have.
 */
describe("skills and docs use the actions routes for recovery", () => {
  const STALE = /recovery-preview|"mode": *"retry_ticket"|finding.?s action/;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const root = new URL("../../", import.meta.url).pathname;
  const documents = [...files(REPO_SKILLS_DIR), ...files(join(root, "docs"))];

  it.each(documents.map((path) => [path.slice(root.length), path]))(
    "%s names no internal recovery route, recovery mode or finding action field",
    (_, path) => {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => `${index + 1}: ${line}`)
        .filter((line) => STALE.test(line));
      expect(lines).toEqual([]);
    },
  );

  it.each(["pidgen-retry-run", "pidgen-replay-node", "pidgen-unstick-ticket"])(
    "%s uses pidgen ticket actions and pidgen ticket act",
    (name) => {
      const content = readFileSync(join(REPO_SKILLS_DIR, name, "SKILL.md"), "utf8");
      expect(content).toMatch(/\bpidgen ticket actions\b/);
      expect(content).toMatch(/\bpidgen ticket act\b/);
      expect(content).not.toMatch(/\/recover\b|\badmin\/tickets\b/);
    },
  );

  it("the recovery skills cover restart_refinement versus replay_from_node, and resolve_target_conflict", () => {
    const content = ["pidgen-retry-run", "pidgen-replay-node", "pidgen-unstick-ticket"]
      .map((name) => readFileSync(join(REPO_SKILLS_DIR, name, "SKILL.md"), "utf8"))
      .join("\n");
    for (const action of ["restart_refinement", "replay_from_node", "resolve_target_conflict"]) {
      expect(content).toContain(action);
    }
  });
});

/**
 * pidgen-decompose-plan has the planner attach each child's brief with `brief_file` or `context_artifacts`
 * (docs/commands.md, "plan apply") instead of appending it to the objective, and says the server
 * must publish the field.
 */
describe("skill pidgen-decompose-plan attaches each child's brief", () => {
  const raw = readFileSync(join(REPO_SKILLS_DIR, "pidgen-decompose-plan", "SKILL.md"), "utf8");
  // Line wrapping aside: the prose is matched as sentences.
  const content = raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(])/g, " ");
  const examples = [...raw.matchAll(/```yaml\n([\s\S]*?)\n```/g)]
    .map((match) => parse(match[1]!) as Record<string, unknown>)
    // Child-plan examples; a manifest example (it has a root) is checked below.
    .filter((example) => "children" in example && !("root" in example));
  const children = examples.flatMap((example) => example["children"] as Record<string, unknown>[]);

  it("names both forms and what a brief holds", () => {
    expect(content).toContain("brief_file");
    expect(content).toContain("context_artifacts");
    for (const part of ["files to change", "pattern to copy", "contract rows", "narrowest test"]) {
      expect(content.toLowerCase(), part).toContain(part);
    }
  });

  it("states the limits: 8192 characters, at most 3 items, relative to the plan file", () => {
    expect(content).toContain("8192");
    expect(content).toMatch(/at most 3|up to 3|three/i);
    expect(content).toMatch(/relative to the plan file/i);
    expect(content).toMatch(/exit 2/);
  });

  it("tells the planner to attach the brief rather than append it to the objective", () => {
    expect(content).toMatch(/not (?:by )?append(?:ing)? (?:it|the brief|a brief) to the objective/i);
  });

  it("notes the server must publish the field", () => {
    expect(content).toMatch(/server must publish/i);
  });

  it("shows each form in a plan example that matches the child-plan schema", () => {
    expect(children.some((child) => typeof child["brief_file"] === "string")).toBe(true);
    expect(children.some((child) => Array.isArray(child["context_artifacts"]))).toBe(true);
    for (const example of examples) {
      expect(() =>
        validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_TEMPLATE, { plan: example }),
      ).not.toThrow();
    }
    for (const child of children) {
      // The two forms are alternatives.
      expect("brief_file" in child && "context_artifacts" in child).toBe(false);
    }
  });
});

/**
 * pidgen-file-ticket and pidgen-decompose-plan file new work as one ticket manifest (docs/commands.md,
 * "manifest"): a structured ticket is a manifest with no children, and a new cohort is one manifest
 * with its root, children and edges, instead of ticket create, plan apply, dep add and plan promote.
 * Both preview, show the findings and plan, commit only on the person's confirmation, and set
 * promote only when the person asked for execution.
 */
describe("skills file work as one manifest", () => {
  const read = (name: string) => readFileSync(join(REPO_SKILLS_DIR, name, "SKILL.md"), "utf8");
  // Line wrapping aside: the prose is matched as sentences.
  const prose = (raw: string) => raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(*])/g, " ");
  const yamlExamples = (raw: string) =>
    [...raw.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
      (match) => parse(match[1]!) as Record<string, unknown>,
    );
  const manifests = (raw: string) => yamlExamples(raw).filter((example) => "root" in example);
  /** The text of one `## ` section, from its heading to the next. */
  const section = (raw: string, heading: RegExp) => {
    const parts = raw.split(/^(?=## )/m);
    const found = parts.find((part) => heading.test(part.split("\n")[0]!));
    expect(found, `no section ${heading}`).toBeDefined();
    return found!;
  };
  const validManifest = (manifest: Record<string, unknown>) =>
    validateBody(MANIFEST_DOCUMENT, "post", MANIFEST_PREVIEW_ROUTE, { manifest });

  describe("pidgen-file-ticket", () => {
    const raw = read("pidgen-file-ticket");

    it("files a structured ticket with pidgen manifest apply and a manifest without children", () => {
      const structured = section(raw, /structured ticket/i);
      expect(structured).toMatch(/\bpidgen manifest template\b[^\n]*--children 0/);
      expect(structured).toMatch(/\bpidgen manifest apply -f \S+/);
      expect(raw).not.toMatch(/\bpidgen ticket create\b/);
      const examples = manifests(structured);
      expect(examples.length).toBeGreaterThan(0);
      for (const manifest of examples) {
        expect(() => validManifest(manifest)).not.toThrow();
        expect((manifest["children"] as unknown[] | undefined) ?? []).toEqual([]);
        expect(manifest["edges"] ?? []).toEqual([]);
      }
    });
  });

  describe("pidgen-decompose-plan", () => {
    const raw = read("pidgen-decompose-plan");

    it("files a new cohort as one manifest with its root, children and edges", () => {
      const filing = section(raw, /one manifest/i);
      expect(filing).toMatch(/\bpidgen manifest template\b/);
      expect(filing).toMatch(/\bpidgen manifest apply -f \S+/);
      const examples = manifests(raw);
      expect(examples.length).toBeGreaterThan(0);
      for (const manifest of examples) {
        expect(() => validManifest(manifest)).not.toThrow();
      }
      const cohort = examples.find(
        (manifest) =>
          ((manifest["children"] as unknown[] | undefined) ?? []).length >= 2 &&
          ((manifest["edges"] as unknown[] | undefined) ?? []).length >= 1,
      );
      expect(cohort, "a manifest example with children and edges").toBeDefined();
    });

    it("no longer files a new cohort with ticket create, plan apply, dep add or plan promote", () => {
      expect(raw).not.toMatch(/\bpidgen ticket create\b/);
      const filing = section(raw, /one manifest/i);
      for (const command of ["plan apply", "ticket dep add", "plan promote", "ticket create"]) {
        expect(filing, command).not.toMatch(new RegExp(`\\bpidgen ${command}\\b`));
      }
      // A cohort's own children and edges live in the manifest; plan apply is for an existing plan.
      const planApply = [...raw.matchAll(/^.*\bpidgen plan apply\b.*$/gm)].map((m) => m.index!);
      const revise = raw.search(/^## .*(?:revise|repair)/im);
      expect(revise).toBeGreaterThan(-1);
      for (const index of planApply) expect(index).toBeGreaterThan(revise);
    });

    it("keeps the cohort grouping rules, pidgen plan cohorts and root-to-root dep add", () => {
      const text = prose(raw);
      expect(text).toMatch(/consumes code, schemas, tests or other artifacts/);
      expect(text).toMatch(/edit the same existing files/);
      expect(raw).toMatch(/\bpidgen plan cohorts -f \S+/);
      expect(text).toMatch(/root-to-root[^.]*`pidgen ticket dep add/i);
      expect(text).toMatch(/a manifest has one root/i);
    });
  });

  describe.each(["pidgen-file-ticket", "pidgen-decompose-plan"])("%s", (name) => {
    const raw = read(name);
    const text = prose(raw);

    it("shows the preview's findings and plan, and commits only after the person confirms", () => {
      expect(text).toMatch(/`pidgen manifest apply -f [^`]+`[^.]*previews?/);
      expect(text).toMatch(/findings/);
      expect(text).toMatch(/`plan`/);
      expect(text).toMatch(/Fix every finding the preview reports, then preview again\./);
      expect(text).toMatch(/commit only after the person confirms/i);
      expect(raw).toMatch(/\bpidgen manifest apply -f \S+ --apply\b/);
      expect(text).toMatch(/MANIFEST_NOT_COMMITTABLE/);
    });

    it("sets promote only when the person asked for execution", () => {
      expect(text).toMatch(/set `promote: true` only when the person asked for (?:the work to run|execution)/i);
      for (const manifest of manifests(raw)) expect(manifest["promote"] ?? false).toBe(false);
    });
  });
});

/**
 * An Epic is an epic-kind Ticket (docs/commands.md, "epic"): it is filed with
 * `pidgen ticket create --kind epic`, keyed like any ticket, and a ticket sits in it by its
 * `parent_ticket_id`. `epic_id` survives only as the intake field the manifest and intent
 * contracts still name for the Epic, and the retired epics:* token scopes are gone.
 */
describe("Epics are epic-kind tickets in the skills and docs", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const SKILLS = ["pidgen-manage-epics", "pidgen-file-ticket", "pidgen-decompose-plan", "pidgen-query-tickets"];

  it.each(SKILLS)("%s names no retired epic key, id or field", (name) => {
    const content = read(`skills/${name}/SKILL.md`);
    expect(content).not.toMatch(/\b[A-Z]+-E\d+\b/);
    expect(content).not.toMatch(/`EPIC-/);
    expect(content).not.toMatch(/\bpriority_weight\b|\bcreate_feature_branch\b|\btarget_completion\b/);
    expect(content).not.toMatch(/\bepic_key\b|\bdata\.progress\b/);
  });

  it.each(SKILLS)("%s says parent_ticket_id, and epic_id only as an intake field", (name) => {
    const content = read(`skills/${name}/SKILL.md`);
    expect(content).toContain("parent_ticket_id");
    // Prose that names epic_id also says it becomes the ticket's parent_ticket_id; YAML keys of
    // a manifest or intent example are the contract's own name and stay.
    const paragraphs = content.split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const prose = paragraph
        .split("\n")
        .filter((line) => !/^\s*epic_id:/.test(line))
        .join("\n");
      if (/\bepic_id\b/.test(prose)) {
        expect(prose, `${name}: ${prose}`).toContain("parent_ticket_id");
      }
    }
  });

  it("pidgen-manage-epics files the Epic with ticket create --kind epic and places members by parent", () => {
    const content = read("skills/pidgen-manage-epics/SKILL.md");
    expect(content).toMatch(/\bpidgen ticket create --kind epic -f \S+/);
    expect(content).toMatch(/\bpidgen ticket list --kind epic\b/);
    expect(content).toMatch(/\bpidgen ticket move \S+ --epic \S+/);
    expect(content).toContain("parent_ticket_id");
    const examples = [...content.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
      (match) => parse(match[1]!) as Record<string, unknown>,
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const body = example["kind"] === undefined ? { ...example, kind: "epic" } : example;
      expect(() => validateBody(PUBLIC_API_DOCUMENT, "post", "/tickets", body)).not.toThrow();
    }
  });

  it("docs/authentication.md lists no epics:* scope", () => {
    expect(read("docs/authentication.md")).not.toMatch(/epics:(read|write)/);
  });

  it("docs/commands.md describes --kind epic and the epic aliases onto the ticket routes", () => {
    const commands = read("docs/commands.md");
    for (const verb of ["create", "list", "show", "edit"]) {
      expect(commands, verb).toMatch(new RegExp(`pidgen ticket ${verb}[^\\n]*--kind`));
    }
    expect(commands).toMatch(/alias/i);
    // The retired Epic routes; a domain's Epics read (/domains/{domain_id}/epics) is not one.
    expect(commands).not.toMatch(/(?<!\{domain_id\})\/epics\b|\/tickets\/\{ref\}\/epic\b/);
    expect(commands).toContain("GET /domains/{domain_id}/epics");
    expect(commands).toContain("parent_ticket_id");
  });
});

/**
 * Work that spans projects (docs/commands.md, "Domain Epics", "contract" and "ticket contract"):
 * pidgen-manage-epics files a Domain Epic in a domain and places each project's work under it by
 * `parent_ticket_id`; pidgen-decompose-plan files one cohort per project under one Domain Epic and, after
 * each commit, links the provider's root to the contract it implements and each consumer's root to
 * the contract it builds against. Neither skill creates a contract or asks a person to approve one:
 * refinement defines the contract, and linked work waits only when the Account's Contract approval
 * setting asks for a person.
 */
describe("the filing skills file cross-project work under a Domain Epic and link it to contracts", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (name: string) => {
    const file = join(REPO_SKILLS_DIR, name, "SKILL.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  // Line wrapping aside: the prose is matched as sentences.
  const prose = (raw: string) => raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(*0-9])/g, " ");
  const yamlExamples = (raw: string) =>
    [...raw.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
      (match) => parse(match[1]!) as Record<string, unknown>,
    );
  /**
   * The text of one `## ` or `### ` section, from its heading to the next heading of either; empty
   * when there is none, so each test that reads it fails on its own.
   */
  const section = (raw: string, heading: RegExp) =>
    raw.split(/^(?=#{2,3} )/m).find((part) => heading.test(part.split("\n")[0]!)) ?? "";

  describe("pidgen-manage-epics", () => {
    const raw = read("pidgen-manage-epics");
    const domain = section(raw, /Domain Epic/);
    const text = prose(domain);

    it("finds the domain with pidgen domain list and checks its Epics with pidgen domain epics", () => {
      expect(domain).toMatch(/\bpidgen domain list\b/);
      expect(domain).toMatch(/\bpidgen domain epics \S+/);
      expect(domain.search(/\bpidgen domain epics\b/)).toBeLessThan(
        domain.search(/\bpidgen ticket create --kind epic --domain\b/),
      );
    });

    it("files it with pidgen ticket create --kind epic --domain and never a branch", () => {
      expect(domain).toMatch(/\bpidgen ticket create --kind epic --domain \S+ -f \S+/);
      expect(text).toMatch(/never[^.]*`branch_mode`[^.]*`feature_branch`/i);
      const examples = yamlExamples(domain);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        for (const field of ["project_id", "branch_mode", "feature_branch", "domain_id"]) {
          expect(example, field).not.toHaveProperty(field);
        }
        // The CLI adds kind and domain_id from --kind epic --domain.
        const body = { ...example, kind: "epic", domain_id: "EXAMPLE" };
        expect(() => validateBody(PUBLIC_API_DOCUMENT, "post", "/tickets", body)).not.toThrow();
      }
    });

    it("places each project's work under it by parent_ticket_id", () => {
      expect(text).toMatch(/each project's work[^.]*`parent_ticket_id`/i);
    });

    it("reads PARENT_OUTSIDE_DOMAIN, DOMAIN_HAS_NO_PROJECTS, EPIC_FIELD_REFUSED and the 403", () => {
      for (const code of ["PARENT_OUTSIDE_DOMAIN", "DOMAIN_HAS_NO_PROJECTS", "EPIC_FIELD_REFUSED"]) {
        expect(domain, code).toContain(code);
      }
      expect(domain).toMatch(/\bpidgen domain project add \S+ \S+/);
      expect(text).toMatch(/403[^.]*exit 3|exit 3[^.]*403/);
    });

    it("keeps the single-project Epic guidance", () => {
      expect(raw).toMatch(/\bpidgen ticket create --kind epic -f \S+/);
      expect(raw).toMatch(/\bpidgen ticket list --kind epic --project \S+/);
    });
  });

  describe("pidgen-decompose-plan", () => {
    const raw = read("pidgen-decompose-plan");
    const spans = section(raw, /Work that spans Projects/);
    const text = prose(spans);

    it("files one cohort per project, each manifest's epic_id naming the same Domain Epic", () => {
      expect(text).toMatch(/one cohort per project/i);
      expect(text).toMatch(/`epic_id`[^.]*same Domain Epic/);
      expect(spans).toMatch(/\bpidgen domain epics \S+/);
    });

    it("finds the contract with pidgen contract list and pidgen contract show", () => {
      expect(spans).toMatch(/\bpidgen contract list --project \S+/);
      expect(spans).toMatch(/\bpidgen contract list --domain \S+/);
      expect(spans).toMatch(/\bpidgen contract show \S+/);
    });

    it("after each commit links the provider's root as implements and each consumer's root as builds-against", () => {
      expect(spans).toMatch(/\bpidgen ticket contract implements \S+ \S+/);
      expect(spans).toMatch(/\bpidgen ticket contract builds-against \S+ \S+ --operation \S+/);
      expect(text).toMatch(/after (?:each|the) commit/i);
      expect(text).toMatch(/provider's (?:delivery )?root/i);
      expect(text).toMatch(/consumer's root/i);
      expect(text).toMatch(/never (?:its |their )?children/i);
      for (const code of [
        "CONTRACT_LINK_NOT_DELIVERY_ROOT",
        "CONTRACT_LINK_OUTSIDE_PROVIDER",
        "CONTRACT_LINK_OWN_PROVIDER",
        "CONTRACT_LINK_INSIDE_COHORT",
        "CONTRACT_DEPRECATED",
        "CONTRACT_RETIRED",
        "CONTRACT_UNKNOWN_OPERATION",
      ]) {
        expect(spans, code).toContain(code);
      }
      expect(text).toMatch(/links? never blocks?/i);
    });

    it("keeps the contract split and the refusal of cross-project dependency edges", () => {
      expect(spans).toContain("DEPENDENCY_CROSS_PROJECT");
      expect(text).toMatch(/Name the contract/);
      expect(text).toMatch(/fixtures/);
      expect(text).toMatch(/external QA plan/);
    });

    it("no longer says a contract cannot be created", () => {
      expect(text).not.toMatch(/no command that creates a contract/i);
      expect(text).not.toMatch(/do not write one/i);
      expect(text).toMatch(/Contract approval setting/);
      expect(text).toMatch(/\bpidgen contract accept\b/);
    });
  });

  describe("pidgen-manage-epics", () => {
    it("names no contract create command", () => {
      expect(read("pidgen-manage-epics")).not.toMatch(/\bcontract create\b/);
    });
  });

  describe.each(["pidgen-manage-epics", "pidgen-decompose-plan", "pidgen-manage-contracts"])("%s", (name) => {
    const raw = read(name);
    const sentences = prose(raw).split(/(?<=[.:;])\s+/);

    it("asks no person to approve a contract, and no criterion waits for an approval", () => {
      // The Account's Contract approval setting is the server's; a skill only reads it.
      const approvals = sentences
        .filter((sentence) => /\bcontracts?\b/i.test(sentence))
        .map((sentence) => sentence.replace(/Contract approval setting/g, ""))
        .filter((sentence) => /\bapprov|\bsign[- ]?off\b/i.test(sentence));
      expect(approvals).toEqual([]);
      const criteria = yamlExamples(raw).flatMap((example) =>
        JSON.stringify(example).match(/"statement":"[^"]*"/g) ?? [],
      );
      for (const statement of criteria) expect(statement).not.toMatch(/approv|sign[- ]?off/i);
    });
  });

  it("docs/skills.md records what each skill now uses", () => {
    const skills = readFileSync(join(root, "docs/skills.md"), "utf8");
    // Each skill has a row in "The skills" and in "What each skill uses"; `\|` is a table's `|`.
    const row = (name: string) =>
      skills
        .split("\n")
        .filter((line) => line.startsWith(`| \`${name}\` |`))
        .map((line) => line.replaceAll("\\|", "|"));
    const [epicUse, epicCommands] = row("pidgen-manage-epics");
    const [decomposeUse, decomposeCommands] = row("pidgen-decompose-plan");
    expect(epicUse).toMatch(/Domain Epic/);
    expect(decomposeUse).toMatch(/Domain Epic/);
    expect(decomposeUse).toMatch(/contract/);
    expect(epicCommands).toContain("`domain list|epics|project add`");
    expect(epicCommands).toMatch(/ticket create[^`]*--domain/);
    expect(decomposeCommands).toContain("`contract list|show|accept`");
    expect(decomposeCommands).toContain("`ticket contract implements|builds-against`");
    expect(decomposeCommands).toContain("`domain epics`");
  });

  it("CHANGELOG.md records the change", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const entry = changelog.split(/^(?=### )/m).find((part) => /Domain Epic/.test(part.split("\n")[0]!) && /skill/i.test(part.split("\n")[0]!));
    expect(entry, "a ### entry naming the skills and Domain Epics").toBeDefined();
    for (const term of ["pidgen-manage-epics", "pidgen-decompose-plan", "pidgen ticket contract implements", "builds-against"]) {
      expect(entry, term).toContain(term);
    }
  });
});

/**
 * A contract is one way, never the required way, to carry another Project's interface
 * (CONTRIBUTING.md, "Rules for skill content", rule 8). pidgen-manage-contracts teaches when a contract is
 * worth creating, finding one first, creating it with `pidgen contract create` from a spec file or a
 * written need, revising it and linking work to it. pidgen-decompose-plan and pidgen-file-ticket present the
 * three ways: attach the spec file to the consumer ticket, state the interface in its scope, or link
 * a contract (reused, or created with pidgen-manage-contracts).
 */
describe("contracts are one of three ways to carry another Project's interface", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (name: string) => readFileSync(join(REPO_SKILLS_DIR, name, "SKILL.md"), "utf8");
  const prose = (raw: string) => raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(*0-9])/g, " ");
  /**
   * The text of one `## `, `### ` or `#### ` section, from its heading to the next heading outside a
   * fenced block (a contract's Markdown in a fence has headings of its own); empty when there is none.
   */
  const section = (raw: string, heading: RegExp) => {
    const parts: string[] = [];
    let fenced = false;
    for (const line of raw.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      if (!fenced && /^#{2,4} /.test(line)) parts.push("");
      if (parts.length > 0) parts[parts.length - 1] += `${line}\n`;
    }
    return parts.find((part) => heading.test(part.split("\n")[0]!)) ?? "";
  };
  const threeWays = (text: string) => {
    expect(text).toMatch(/attach the (?:provider's )?spec(?:ification)? file/i);
    expect(text).toMatch(/state the interface in (?:the consumer ticket's |its |the ticket's )?scope/i);
    expect(text).toMatch(/link a contract/i);
    expect(text).toMatch(/\bpidgen-manage-contracts\b/);
    expect(text).toMatch(/never required|not required|need not|does not need a contract/i);
  };

  describe("pidgen-manage-contracts", () => {
    const file = join(REPO_SKILLS_DIR, "pidgen-manage-contracts", "SKILL.md");
    const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
    const text = prose(raw);

    it("exists as a bundled skill", () => {
      expect(raw, "skills/pidgen-manage-contracts/SKILL.md").not.toBe("");
    });

    it("says when to create a contract and when to attach the spec file or state it in scope instead", () => {
      const when = prose(section(raw, /^#{2,3} When/));
      expect(when).toMatch(/shared by several/i);
      expect(when).toMatch(/likely to change/i);
      expect(when).toMatch(/announc/i);
      expect(when).toMatch(/attach the (?:provider's )?spec(?:ification)? file/i);
      expect(when).toMatch(/state the interface in (?:the ticket's |its )?scope/i);
    });

    it("finds an existing contract before publishing or proposing one", () => {
      expect(raw).toMatch(/\bpidgen contract list --project \S+/);
      expect(raw).toMatch(/\bpidgen contract list --domain \S+/);
      expect(raw).toMatch(/\bpidgen contract show \S+/);
      // In the body: the description names the command it is about.
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(body.search(/\bpidgen contract list\b/)).toBeGreaterThanOrEqual(0);
      expect(body.search(/\bpidgen contract list\b/)).toBeLessThan(
        body.search(/\bpidgen contract (?:publish|propose)\b/),
      );
    });

    it("proposes what does not exist yet from a fragment holding only the operations needed", () => {
      const propose = section(raw, /propose/i);
      expect(propose, "a section on proposing").not.toBe("");
      expect(propose).toMatch(/\bpidgen contract propose --project \S+ --title "[^"]+" \S+/);
      expect(propose).toMatch(/\bpidgen contract propose CT-\d+ \S+/);
      expect(prose(propose)).toMatch(/only the operations/i);
      expect(propose).toMatch(/--check\b/);
    });

    it("its revise body is what the server accepts, and carries no schema", () => {
      const bodies = [...raw.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
        (match) => parse(match[1]!) as Record<string, unknown>,
      );
      const revise = bodies.find((body) => "change" in body);
      expect(revise, "a revise body").toBeDefined();
      // --markdown supplies the document.
      expect(() =>
        validateBody(PUBLIC_API_DOCUMENT, "post", "/contracts/{contract_id}/revisions", {
          ...revise,
          markdown: "# Payment status",
        }),
      ).not.toThrow();
      for (const body of bodies) expect(body).not.toHaveProperty("native_schema");
    });

    it("revises it and links work to it", () => {
      expect(raw).toMatch(/\bpidgen contract revise \S+ -f \S+/);
      expect(raw).toMatch(/\bpidgen ticket contract implements \S+ \S+/);
      expect(raw).toMatch(/\bpidgen ticket contract builds-against \S+ \S+/);
      expect(text).toMatch(/Contract approval setting/);
    });
  });

  describe("pidgen-decompose-plan", () => {
    const spans = section(read("pidgen-decompose-plan"), /Work that spans Projects/);

    it("presents the three ways in Work that spans Projects", () => {
      threeWays(prose(spans));
    });

    it("keeps the provider change, the consumer's fixtures and the external QA plan", () => {
      const text = prose(spans);
      expect(text).toMatch(/Give the provider change an owner/);
      expect(text).toMatch(/fixtures/);
      expect(text).toMatch(/external QA plan/);
    });
  });

  describe("pidgen-file-ticket", () => {
    const raw = read("pidgen-file-ticket");

    it("presents the three ways when another Project must change", () => {
      const paragraph = raw
        .split(/\n\n/)
        .map(prose)
        .find((part) => /another Project must change/.test(part));
      expect(paragraph, "the paragraph on another Project's change").toBeDefined();
      threeWays(paragraph!);
      expect(paragraph).not.toMatch(/name the agreed contract/i);
    });
  });

  it("docs/skills.md lists pidgen-manage-contracts and what it uses", () => {
    const skills = readFileSync(join(root, "docs/skills.md"), "utf8");
    const rows = skills
      .split("\n")
      .filter((line) => line.startsWith("| `pidgen-manage-contracts` |"))
      .map((line) => line.replaceAll("\\|", "|"));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("`contract list|show|publish|propose|revise|accept`");
    expect(rows[1]).toContain("`ticket contract implements|builds-against`");
    expect(skills).not.toMatch(/Neither skill creates a contract/);
  });
});

/**
 * Requests in the skills. pidgen-file-ticket says when to file a Request rather than a ticket and
 * shows `pidgen request submit` with a bug's details and evidence; pidgen-triage-requests works the queue
 * with `pidgen request list`, `show`, `acknowledge`, `reply --ask`, `accept`, `close` and `promote`.
 * Every `pidgen request …` line they show uses only flags the command declares.
 */
describe("the skills file and triage Requests", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (name: string) => {
    const file = join(REPO_SKILLS_DIR, name, "SKILL.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const prose = (raw: string) => raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(*0-9])/g, " ");
  const section = (raw: string, heading: RegExp) =>
    raw.split(/^(?=#{2,3} )/m).find((part) => heading.test(part.split("\n")[0]!)) ?? "";
  /** The long flags `pidgen request <verb>` declares, with the global ones. */
  const flags = (verb: string) => {
    const spec = commands.find((c) => commandName(c) === `request ${verb}`);
    if (!spec) return undefined;
    const command = new Command();
    spec.configure?.(command);
    return new Set([
      ...command.options.map((option) => option.long),
      "--profile",
      "--account",
      "--format",
      "--timeout",
    ]);
  };
  /** Each `pidgen request …` command line in a console block, continuation lines joined. */
  const requestLines = (raw: string) =>
    [...raw.matchAll(/```console\n([\s\S]*?)\n```/g)]
      .flatMap((match) => match[1]!.replace(/\\\n\s*/g, " ").split("\n"))
      .map((line) => line.replace(/^\$\s*/, "").trim())
      .filter((line) => line.startsWith("pidgen request "));
  const checkFlags = (raw: string) => {
    const lines = requestLines(raw);
    for (const line of lines) {
      const verb = line.split(/\s+/)[2]!;
      const known = flags(verb);
      expect(known, `pidgen request ${verb} is not a command`).toBeDefined();
      for (const [flag] of line.matchAll(/(?<=\s)--[a-z][a-z-]*/g)) {
        expect(known!.has(flag), `${line}: pidgen request ${verb} has no ${flag}`).toBe(true);
      }
    }
    return lines;
  };

  describe("pidgen-file-ticket", () => {
    const raw = read("pidgen-file-ticket");
    const when = section(raw, /request/i);

    it("says when to file a request rather than a ticket", () => {
      expect(when, "a section on filing a request").not.toBe("");
      const text = prose(when);
      expect(text).toMatch(/outside the team/i);
      expect(text).toMatch(/not (?:yet )?(?:been )?judged worth doing/i);
      expect(text).toMatch(/target is unclear/i);
      expect(text).toMatch(/\bpidgen-triage-requests\b/);
      // The trigger mentions it too, so an agent picks the skill for a request.
      expect(frontmatter(raw)["description"]).toMatch(/request/i);
    });

    it("shows pidgen request submit with a bug's details and evidence", () => {
      const lines = checkFlags(when).filter((line) => /^pidgen request submit\b/.test(line));
      const bug = lines.find((line) => /--kind bug\b/.test(line));
      expect(bug, "a pidgen request submit --kind bug example").toBeDefined();
      for (const flag of ["--title", "--body", "--steps", "--expected", "--actual", "--evidence"]) {
        expect(bug, flag).toContain(`${flag} `);
      }
      const text = prose(when);
      expect(text).toMatch(/data\.outcome/);
      expect(text).toMatch(/data\.url/);
      expect(text).toMatch(/--fingerprint/);
      expect(text).toMatch(/REQUEST_SOURCE_PAUSED/);
      expect(text).toMatch(/REQUEST_RATE_LIMITED/);
    });
  });

  describe("pidgen-triage-requests", () => {
    const raw = read("pidgen-triage-requests");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");

    it("exists as a bundled skill", () => {
      expect(raw, "skills/pidgen-triage-requests/SKILL.md").not.toBe("");
    });

    it("walks the queue: list new, show, acknowledge or ask, accept, close, promote", () => {
      const lines = checkFlags(raw);
      const at = (pattern: RegExp) => {
        const index = body.search(pattern);
        expect(index, String(pattern)).toBeGreaterThanOrEqual(0);
        return index;
      };
      const order = [
        at(/pidgen request list --state new\b/),
        at(/pidgen request show \S+/),
        at(/pidgen request acknowledge \S+/),
        at(/pidgen request reply \S+ --text "[^"]+" --ask\b/),
        at(/pidgen request accept \S+/),
        at(/pidgen request close \S+ --reason /),
        at(/pidgen request promote \S+ --project \S+/),
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const verb of ["list", "show", "acknowledge", "reply", "accept", "close", "promote"]) {
        expect(lines.some((line) => line.startsWith(`pidgen request ${verb} `)), verb).toBe(true);
      }
    });

    it("accepts with a bug's details or names the unknown ones", () => {
      expect(body).toMatch(/pidgen request accept \S+ --priority P[1-4]\b/);
      expect(body).toMatch(/pidgen request accept \S+[^\n]*--unknown (?:steps|expected|actual)\b/);
      expect(body).toMatch(/REQUEST_BUG_DETAILS_REQUIRED/);
    });

    it("closes with a reason: duplicate with --duplicate-of, other with --note", () => {
      expect(body).toMatch(/pidgen request close \S+ --reason duplicate --duplicate-of \S+/);
      expect(body).toMatch(/pidgen request close \S+ --reason other --note "[^"]+"/);
    });

    it("reads the envelope and branches on the stated refusals", () => {
      for (const code of [
        "REQUEST_NOT_FOUND",
        "REQUEST_VERSION_CONFLICT",
        "REQUEST_TRANSITION_REFUSED",
        "REQUEST_REPLIES_OFF",
        "REQUEST_TARGET_NEEDS_PROJECT",
      ]) {
        expect(body, code).toContain(code);
      }
      expect(body).toMatch(/data\.state/);
      expect(body).toMatch(/data\.ticket_id/);
      expect(body).toMatch(/waiting_on_requester/);
      // Triage needs no preview: no request command takes --apply or --ack.
      for (const line of requestLines(raw)) expect(line).not.toMatch(/--apply|--ack\b/);
    });
  });

  it("docs/skills.md lists pidgen-triage-requests and the request path in pidgen-file-ticket", () => {
    const skills = readFileSync(join(root, "docs/skills.md"), "utf8");
    const rows = (name: string) =>
      skills
        .split("\n")
        .filter((line) => line.startsWith(`| \`${name}\` |`))
        .map((line) => line.replaceAll("\\|", "|"));
    const triage = rows("pidgen-triage-requests");
    expect(triage).toHaveLength(2);
    expect(triage[0]).toMatch(/request/i);
    expect(triage[1]).toContain("`request list|show|reply|acknowledge|accept|close|promote`");
    const [workUse, workCommands] = rows("pidgen-file-ticket");
    expect(workUse).toMatch(/request/i);
    expect(workCommands).toContain("`request submit`");
  });

  it("CHANGELOG.md records pidgen-triage-requests and the request path in pidgen-file-ticket", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const unreleased = changelog.split(/^## /m).find((part) => part.startsWith("Unreleased"));
    expect(unreleased?.split("\n")[0]).toBe("Unreleased");
    const entry = changelog
      .split(/^(?=### )/m)
      .find((part) => /pidgen-triage-requests/.test(part.split("\n")[0]!));
    expect(entry, "a ### entry naming pidgen-triage-requests").toBeDefined();
    for (const term of ["pidgen-file-ticket", "pidgen request submit", "pidgen skills install"]) {
      expect(entry, term).toContain(term);
    }
  });
});

/**
 * pidgen-manage-contracts is written around the commands that put contracts into Pidgen as files
 * (docs/commands.md, "contract"): choose publish, propose, attach or link; never write a schema into a
 * command, a body or a ticket; `--check` before publishing, and stop for a breaking change; set up CI
 * with publish on the default branch and `--check` on pull requests, the token a secret; read landed
 * and pending; and cover every refusal code the publishing fragment declares. pidgen-decompose-plan
 * says a root building against a pending operation builds against a mock.
 */
describe("pidgen-manage-contracts publishes and proposes files", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (name: string) => {
    const file = join(REPO_SKILLS_DIR, name, "SKILL.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const prose = (raw: string) => raw.replace(/[ \t]*\n[ \t]*(?=[A-Za-z`(*0-9|])/g, " ");
  /** The text of one heading's section, to the next heading outside a fence; empty when none. */
  const section = (raw: string, heading: RegExp) => {
    const parts: string[] = [];
    let fenced = false;
    for (const line of raw.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      if (!fenced && /^#{2,4} /.test(line)) parts.push("");
      if (parts.length > 0) parts[parts.length - 1] += `${line}\n`;
    }
    return parts.find((part) => heading.test(part.split("\n")[0]!)) ?? "";
  };
  const raw = read("pidgen-manage-contracts");
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const text = prose(body);
  /** Every `pidgen contract …` command line in a console block or a CI step. */
  const contractLines = [...body.matchAll(/```(?:console|yaml)\n([\s\S]*?)\n```/g)]
    .flatMap((match) => match[1]!.replace(/\\\n\s*/g, " ").split("\n"))
    .map((line) => /\bpidgen contract [^\n]*/.exec(line)?.[0].trim())
    .filter((line): line is string => line !== undefined);
  const flags = (verb: string) => {
    const spec = commands.find((c) => commandName(c) === `contract ${verb}`);
    if (!spec) return undefined;
    const command = new Command();
    spec.configure?.(command);
    return new Set([
      ...command.options.map((option) => option.long),
      "--profile",
      "--account",
      "--format",
      "--timeout",
    ]);
  };

  it("triggers on publishing a spec, setting up CI, and proposing an interface", () => {
    const description = frontmatter(raw)["description"] ?? "";
    expect(description).toMatch(/publish/i);
    expect(description).toMatch(/\bCI\b/);
    expect(description).toMatch(/propos/i);
    expect(description).toMatch(/landed/i);
  });

  it("chooses publish, propose, attach or link", () => {
    const choose = prose(section(raw, /choose/i));
    expect(choose, "a section choosing the path").not.toBe("");
    expect(choose).toMatch(/`pidgen contract publish --format json`/);
    expect(choose).toMatch(/`pidgen contract propose --format json`/);
    expect(choose).toMatch(/attach the (?:spec )?file/i);
    expect(choose).toMatch(/\blink\b/i);
    expect(choose).toMatch(/exists/i);
    expect(choose).toMatch(/does(?:n't| not) exist yet/i);
  });

  it("each pidgen contract line uses only flags the command declares", () => {
    expect(contractLines.some((line) => line.startsWith("pidgen contract publish "))).toBe(true);
    expect(contractLines.some((line) => line.startsWith("pidgen contract propose "))).toBe(true);
    for (const line of contractLines) {
      const verb = line.split(/\s+/)[2]!;
      const known = flags(verb);
      expect(known, `pidgen contract ${verb} is not a command`).toBeDefined();
      for (const [flag] of line.matchAll(/(?<=\s)--[a-z][a-z-]*/g)) {
        expect(known!.has(flag), `${line}: pidgen contract ${verb} has no ${flag}`).toBe(true);
      }
    }
  });

  describe("AC-a2618968d519: --check before publishing, and stop for a breaking change", () => {
    it("runs publish --check before the first publish that records", () => {
      const check = body.search(/\bpidgen contract publish \S+ --project \S+[^\n]*--check\b/);
      const record = body.search(/\bpidgen contract publish \S+ --project \S+(?![^\n]*--check)[^\n]*$/m);
      expect(check, "a publish --check example").toBeGreaterThanOrEqual(0);
      expect(record, "a publish example without --check").toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(record);
      expect(text).toMatch(/run `?--check`? (?:first|before)/i);
    });

    it("reads the dry run's change and operations from the envelope", () => {
      for (const field of ["data.change", "data.added", "data.removed", "data.landed"]) {
        expect(text, field).toContain(field);
      }
      expect(text).toMatch(/`unchanged`[^.]*nothing to do/i);
      expect(text).toContain("CONTRACT_CHANGE_BREAKING");
    });

    it("stops and asks the person before publishing a breaking change", () => {
      expect(text).toMatch(/stop and ask the person before publishing a breaking change/i);
      expect(text).toMatch(/--breaking[^.]*only (?:when|after|once) the person/i);
    });
  });

  describe("AC-41a7f3c03e5d: never a schema in a command, body or ticket; files instead", () => {
    it("forbids writing a schema into a command, a body or a ticket and passes the file path", () => {
      expect(text).toMatch(/never write a schema into a command, a body or a ticket/i);
      expect(text).toMatch(/pass the file(?:'s)? path/i);
      expect(text).toMatch(/never copy an existing spec's text/i);
      expect(text).toMatch(/never use `pidgen contract revise --format json` to store a spec/i);
    });

    it("no longer teaches reading a schema into pidgen contract create", () => {
      expect(body).not.toMatch(/\bpidgen contract create\b[^\n]*--schema\b/);
      expect(body).not.toMatch(/--schema-format/);
      // native_schema is named, if at all, only to say never.
      for (const sentence of text.split(/(?<=[.:;])\s+/).filter((s) => /native_schema/.test(s))) {
        expect(sentence).toMatch(/\bnever\b/i);
      }
    });
  });

  describe("AC-f71329025841: CI files, and every refusal code of the publishing fragment", () => {
    const ci = section(raw, /\bCI\b/);

    it("names the CI files it looks for", () => {
      expect(ci, "a section on CI").not.toBe("");
      for (const file of [".github/workflows/", ".gitea/workflows/", ".gitlab-ci.yml"]) {
        expect(ci, file).toContain(file);
      }
    });

    it("publishes on the default branch and checks pull requests, the token a secret", () => {
      const t = prose(ci);
      expect(t).toMatch(/with the person's agreement/i);
      expect(t).toMatch(/default branch/i);
      expect(t).toMatch(/pull requests?/i);
      for (const name of ["PIDGEN_API_URL", "PIDGEN_ACCOUNT", "PIDGEN_TOKEN"]) {
        expect(t, name).toContain(name);
      }
      expect(t).toMatch(/secret/i);
      expect(t).toMatch(/never write a token into a file/i);
      const steps = [...ci.matchAll(/```yaml\n([\s\S]*?)\n```/g)].flatMap(
        (match) => parse(match[1]!) as Record<string, unknown>[],
      );
      const runs = steps.map((step) => String(step["run"] ?? ""));
      expect(runs.some((run) => /pidgen contract publish \S+ --project \S+ --commit/.test(run))).toBe(true);
      expect(runs.some((run) => /pidgen contract publish \S+ --project \S+ --check\b/.test(run))).toBe(true);
      expect(ci).toMatch(/PIDGEN_TOKEN: \$\{\{ secrets\.PIDGEN_TOKEN \}\}/);
    });

    it("covers every refusal code of a published file", () => {
      // The codes the publish routes state (checked against contracts/openapi.json by the command tests).
      const codes = Object.keys(FILE_REFUSALS);
      expect(codes.length).toBeGreaterThan(0);
      const errors = section(raw, /error/i);
      for (const code of codes) expect(errors, code).toMatch(new RegExp(`^\\| \`${code}\` \\|`, "m"));
      expect(errors).toMatch(/exit 3/);
    });

    it("reads landed and pending with pidgen contract show", () => {
      const t = prose(section(raw, /pending/i));
      expect(t).toMatch(/\bpidgen contract show \S+/);
      for (const state of ["landed", "pending", "removed"]) expect(t, state).toContain(`\`${state}\``);
      expect(t).toMatch(/merged, but not in the published spec/i);
      expect(t).toMatch(/do(?:n't| not) re-?propose/i);
    });
  });

  describe("AC-c3de795fd699: the pending rule in pidgen-decompose-plan", () => {
    it("says a root that builds against a pending operation builds against a mock", () => {
      const spans = prose(section(read("pidgen-decompose-plan"), /Work that spans Projects/));
      expect(spans).toMatch(/pending operation[^.]*builds? against a mock/i);
      expect(spans).toMatch(/`pidgen contract show/);
    });
  });

  it("docs/skills.md describes the rewritten skill", () => {
    const skills = readFileSync(join(root, "docs/skills.md"), "utf8");
    const [use] = skills
      .split("\n")
      .filter((line) => line.startsWith("| `pidgen-manage-contracts` |"));
    expect(use).toMatch(/publish/);
    expect(use).toMatch(/propos/);
    expect(use).toMatch(/CI/);
    expect(skills).toMatch(/pending operation[^.]*mock/);
    expect(skills).not.toMatch(/creates one with `pidgen contract create` from a\s+spec file/);
  });
});

// AC-2a73ad50f309, AC-c0a858c6f727: public guidance agrees with the presentation contract.
describe("terminal output documentation", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  it.each(["### ticket history", "## intent", "## session", "## api"])(
    "%s qualifies envelope output as JSON mode",
    (heading) => {
      const section = read("docs/commands.md").split(`${heading}\n`)[1]?.split(/\n#{1,3} /)[0];
      expect(section, `missing ${heading} section`).toBeDefined();
      expect(section).toMatch(/In JSON mode[^.]*envelope/i);
      expect(section).not.toMatch(/Every command\s+prints one envelope/);
    },
  );
  it.each(["README.md", "AGENTS.md", "CONTRIBUTING.md", "docs/output-and-exit-codes.md", "docs/architecture.md", "docs/README.md", "docs/commands.md", "docs/skills.md", "docs/preview-and-apply.md", "docs/planning-cohorts.md"])("%s explains stdout defaults and explicit JSON", (path) => {
    const content = read(path);
    expect(content).toMatch(/stdout|standard output/i);
    expect(content).toMatch(/terminal/i);
    expect(content).toContain("--format json");
    expect(content).not.toMatch(/Every command (?:prints|writes)(?: exactly)? one JSON|json. is the default|JSON envelope by default/);
  });
  it("documents overrides, stable envelopes and codes, and stream exceptions", () => {
    const content = read("docs/output-and-exit-codes.md");
    for (const text of ["--format json", "--format table", "--help", "--version", "worker start", "standard error", "Exit codes", '"ok"', '"data"', '"error"', '"meta"']) expect(content).toContain(text);
    expect(content).toMatch(/parser|parsing|usage/i);
    expect(content).toMatch(/unchanged|preserv/i);
  });
  it("explains the breaking terminal default, migration and skill contract change", () => {
    const release = read("CHANGELOG.md").split("## 0.1.0-alpha.1")[1]!;
    for (const pattern of [/breaking/i, /terminal/i, /nonterminal|non-terminal|redirect|pipe/i, /--format json/, /skill.*contract|contract.*skill/i]) expect(release).toMatch(pattern);
    expect(read("docs/skills.md")).toMatch(/--format json[^.]*terminal|terminal[^.]*--format json/s);
  });
});

/**
 * AC-e52d85d96335: pidgen-project-readiness teaches an agent the four readiness commands
 * (docs/commands.md, "project inspect, setup, rehearse and doctor") and names only `pidgen`
 * commands: every command line and every command-like code span is a `pidgen` invocation.
 */
describe("skill pidgen-project-readiness", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const file = join(REPO_SKILLS_DIR, "pidgen-project-readiness", "SKILL.md");
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const blocks = [...raw.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]!);

  it("exists as a bundled skill and is not exempt from the content rules", () => {
    expect(raw, "missing skills/pidgen-project-readiness/SKILL.md").not.toBe("");
    expect(imported).not.toContain("pidgen-project-readiness");
  });

  it("teaches the four commands: inspect, setup, rehearse and doctor", () => {
    for (const verb of ["inspect", "setup", "rehearse", "doctor"]) {
      expect(raw, verb).toMatch(new RegExp(`\\bpidgen project ${verb}\\b`));
    }
    for (const flag of ["--answer", "--write", "--pull-request", "--ref", "--since", "--propose-fix"]) {
      expect(raw, flag).toContain(flag);
    }
  });

  it("names only pidgen commands", () => {
    const lines = blocks
      .flatMap((block) => block.replace(/\\\n\s*/g, " ").split("\n"))
      .map((line) => line.trim().replace(/^\$\s+/, ""))
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(/^pidgen [a-z]/);
    const spans = [...raw.replace(/^```[\s\S]*?^```/gm, "").matchAll(/`([^`\n]+)`/g)].map(
      (match) => match[1]!,
    );
    for (const span of spans.filter((text) => /^[a-z][\w.-]*\s+[\w-]/.test(text))) {
      expect(span, span).toMatch(/^pidgen /);
    }
  });

  it("reads the doctor's verdict: exit 1 with SETUP_IS_THE_PROBLEM and the report in error.details.report", () => {
    expect(raw).toContain("SETUP_IS_THE_PROBLEM");
    expect(raw).toContain("error.details.report");
    expect(raw).toMatch(/exit(?:s)? 1/);
    expect(raw).toMatch(/never gates/i);
  });

  it("is listed in docs/skills.md and README.md", () => {
    for (const doc of ["docs/skills.md", "README.md"]) {
      expect(readFileSync(join(root, doc), "utf8"), doc).toMatch(/^\| `pidgen-project-readiness` \|/m);
    }
  });

  // AC-2cc4475ac8f5, AC-d23833d85997: the three verdicts and their exits, and --write's refusal
  // of an existing .pidgen/.
  it("reads the three verdicts, setup exiting 1 and code or unclear exiting 0, and --write's refusal", () => {
    for (const verdict of ["`setup`", "`code`", "`unclear`"]) expect(raw, verdict).toContain(verdict);
    expect(raw).toMatch(/`code` or `unclear`[^.]*exits 0/);
    expect(raw).toMatch(/existing `\.pidgen\/`[^.]*`FILES_EXIST`/);
  });

  it("is where pidgen-setup-worker points once the worker runs", () => {
    const worker = readFileSync(join(REPO_SKILLS_DIR, "pidgen-setup-worker", "SKILL.md"), "utf8");
    expect(worker).toContain("pidgen-project-readiness");
    expect(worker).toMatch(/pidgen project rehearse [A-Z]+ --format json/);
  });
});
