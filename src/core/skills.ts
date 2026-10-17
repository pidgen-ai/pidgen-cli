import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

/**
 * Installing the bundled agent skills into agents' skill directories. See docs/skills.md.
 * Copies are stamped with the CLI version and the bundled content hash so later runs can tell
 * current, stale and hand-edited copies apart.
 */

export const AGENTS = {
  claude: { skillsDir: join(".claude", "skills"), marker: ".claude" },
  codex: { skillsDir: join(".agents", "skills"), marker: ".codex" },
  pi: { skillsDir: join(".agents", "skills"), marker: ".pi" },
} as const;

export type Agent = keyof typeof AGENTS;
export type Scope = "user" | "project";
export type SkillState = "current" | "stale" | "edited" | "missing";

const VERSION_FIELD = "pidgen-cli-version";
const HASH_FIELD = "pidgen-skill-hash";
const SKILL_FILE = "SKILL.md";

export interface BundledSkill {
  name: string;
  dir: string;
  content: string;
  hash: string;
}

export interface Target {
  dir: string;
  agents: Agent[];
}

export interface Selection {
  agent: Agent | "all";
  scope: Scope;
}

export async function readBundledSkills(skillsDir: string): Promise<BundledSkill[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    throw new CliError(
      "CLI_INTERNAL",
      `Bundled skills not found at ${skillsDir}.`,
      ExitCode.Unexpected,
    );
  }
  const skills: BundledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) continue;
    const content = await readFile(file, "utf8");
    skills.push({ name: entry.name, dir, content, hash: hashContent(content) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function hashContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
}

/** Adds the version and hash fields at the end of the frontmatter. */
export function stamp(content: string, version: string, hash: string): string {
  const end = frontmatterEnd(content);
  if (end === -1) {
    throw new CliError("CLI_INTERNAL", "A bundled skill has no frontmatter.", ExitCode.Unexpected);
  }
  return (
    content.slice(0, end) +
    `${VERSION_FIELD}: ${version}\n${HASH_FIELD}: ${hash}\n` +
    content.slice(end)
  );
}

/** Reads and removes the stamp fields, returning the content as it was bundled. */
export function readStamp(content: string): { version?: string; hash?: string; body: string } {
  const end = frontmatterEnd(content);
  if (end === -1) return { body: content };
  const head = content.slice(0, end).split("\n");
  const result: { version?: string; hash?: string } = {};
  const kept: string[] = [];
  for (const line of head) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (match?.[1] === VERSION_FIELD && match[2] !== undefined) result.version = match[2];
    else if (match?.[1] === HASH_FIELD && match[2] !== undefined) result.hash = match[2];
    else kept.push(line);
  }
  return { ...result, body: kept.join("\n") + content.slice(end) };
}

/** Index of the closing `---` line of a leading frontmatter block, or -1. */
function frontmatterEnd(content: string): number {
  const normalized = content.replaceAll("\r\n", "\n");
  if (normalized !== content || !content.startsWith("---\n")) return -1;
  const close = content.indexOf("\n---\n", 3);
  return close === -1 ? -1 : close + 1;
}

export function classify(
  installed: string | null,
  bundled: BundledSkill,
): { state: SkillState; installed_version: string | null } {
  if (installed === null) return { state: "missing", installed_version: null };
  const { version, hash, body } = readStamp(installed);
  const installedVersion = version ?? null;
  // A copy without a stamp was not written by this CLI; treat it like an edited one.
  if (hash === undefined || hashContent(body) !== hash) {
    return { state: "edited", installed_version: installedVersion };
  }
  return {
    state: hash === bundled.hash ? "current" : "stale",
    installed_version: installedVersion,
  };
}

export function resolveTargets(ctx: RunContext, selection: Selection): Target[] {
  const agents: Agent[] =
    selection.agent === "all"
      ? (Object.keys(AGENTS) as Agent[]).filter((agent) =>
          existsSync(join(ctx.homeDir, AGENTS[agent].marker)),
        )
      : [selection.agent];
  if (agents.length === 0) {
    throw usageError("No supported agent found in your home directory. Pass --agent.", {
      agents: Object.keys(AGENTS),
    });
  }
  const base = selection.scope === "user" ? ctx.homeDir : ctx.cwd;
  const targets = new Map<string, Agent[]>();
  for (const agent of agents) {
    const dir = join(base, AGENTS[agent].skillsDir);
    targets.set(dir, [...(targets.get(dir) ?? []), agent]);
  }
  return [...targets].map(([dir, grouped]) => ({ dir, agents: grouped }));
}

async function readInstalled(targetDir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(targetDir, name, SKILL_FILE), "utf8");
  } catch {
    return null;
  }
}

export interface StatusRow {
  skill: string;
  dir: string;
  agents: Agent[];
  state: SkillState;
  installed_version: string | null;
}

export async function skillsStatus(ctx: RunContext, selection: Selection): Promise<StatusRow[]> {
  const bundled = await readBundledSkills(ctx.bundledSkillsDir);
  const rows: StatusRow[] = [];
  for (const target of resolveTargets(ctx, selection)) {
    for (const skill of bundled) {
      const installed = await readInstalled(target.dir, skill.name);
      rows.push({
        skill: skill.name,
        dir: target.dir,
        agents: target.agents,
        ...classify(installed, skill),
      });
    }
  }
  return rows;
}

export type InstallAction = "installed" | "updated" | "unchanged" | "skipped_edited";

export interface InstallRow {
  skill: string;
  dir: string;
  agents: Agent[];
  action: InstallAction;
}

export async function installSkills(
  ctx: RunContext,
  selection: Selection,
  options: { force: boolean; version: string },
): Promise<InstallRow[]> {
  const bundled = await readBundledSkills(ctx.bundledSkillsDir);
  const rows: InstallRow[] = [];
  for (const target of resolveTargets(ctx, selection)) {
    for (const skill of bundled) {
      const { state } = classify(await readInstalled(target.dir, skill.name), skill);
      let action: InstallAction;
      if (state === "current") action = "unchanged";
      else if (state === "edited" && !options.force) action = "skipped_edited";
      else {
        const destination = join(target.dir, skill.name);
        await mkdir(destination, { recursive: true });
        await cp(skill.dir, destination, { recursive: true, force: true });
        await writeFile(
          join(destination, SKILL_FILE),
          stamp(skill.content, options.version, skill.hash),
        );
        action = state === "missing" ? "installed" : "updated";
      }
      rows.push({ skill: skill.name, dir: target.dir, agents: target.agents, action });
    }
  }
  return rows;
}
