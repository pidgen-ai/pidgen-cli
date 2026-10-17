// Checks docs/ against the docs bundle contract (format 1) that the CLI, the worker and the docs
// site share, so no release carries a bundle docs.pidgen.ai would refuse, and packs it.
//
// Usage: node scripts/docs-bundle.mjs check [dir]               (npm run docs:check)
//        node scripts/docs-bundle.mjs pack [dir] [--out <dir>]  (npm run docs:pack)
// dir defaults to docs. pack checks first, then writes pidgen-cli-docs-<version>.tar.gz (to the
// current directory unless --out names another) holding docs-bundle.json, navigation.json,
// README.md and the pages navigation.json lists. Links that leave the bundle are rewritten to the
// public repository at the release tag: https://github.com/pidgen-ai/pidgen-cli/blob/v<version>/.
//
// The contract, for the checks made here:
//   - README.md is the landing page; every other page appears exactly once in navigation.json,
//     and every path navigation.json lists exists.
//   - Each page's first heading is its '#' title.
//   - Relative links (page.md, page.md#anchor, #anchor) resolve, fragments using GitHub's heading
//     slugs. Links inside fenced code blocks or inline code, and absolute URLs, are not followed.
//     Links to repository files outside the docs directory are allowed: packing rewrites them to
//     the public repository URL. They must still exist (a file, or a directory outside docs/).
//   - No private material, fenced code included: internal citations (scripts/contract-check.mjs),
//     localhost or LAN addresses, /home/ or /srv/ paths, internal names (Gitea),
//     Account ids other than ACC-EXAMPLE, credentials. Placeholders are pidgen.example.com,
//     ACC-EXAMPLE and obviously fake tokens.
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { CITATION_PATTERNS } from "./contract-check.mjs";

/** The landing page: served at /<product>/ and never listed in navigation.json. */
export const LANDING_PAGE = "README.md";
export const NAVIGATION_FILE = "navigation.json";
export const MANIFEST_FILE = "docs-bundle.json";
export const PRODUCT = "cli";
/** The public repository that links leaving the bundle point at, at the release tag. */
export const REPOSITORY_URL = "https://github.com/pidgen-ai/pidgen-cli";
/** The repository root: the parent of scripts/. */
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A token that says it is a placeholder: "example", "fake", "dummy", or a run of x's. */
const PLACEHOLDER_TOKEN = /example|fake|dummy|xxxx/i;

/**
 * Patterns for private material. Each match is reported unless `allow` accepts it. The citation
 * patterns of scripts/contract-check.mjs apply, except source paths: guides show files of the
 * reader's own project (src/app/auth.py), which cite nothing internal.
 */
export const PRIVATE_PATTERNS = [
  ...CITATION_PATTERNS.filter(({ name }) => name !== "source path"),
  { name: "localhost address", pattern: /\blocalhost\b/gi },
  { name: "loopback address", pattern: /\b(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0)\b|\[::1\]/g },
  {
    name: "LAN address",
    pattern:
      /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})\b/g,
  },
  { name: "LAN hostname", pattern: /\b[\w-]+\.(?:local|lan|internal|home\.arpa)\b/gi },
  { name: "local path", pattern: /\/(?:home|srv)\//g },
  { name: "internal name", pattern: /\bgitea\b/gi },
  { name: "Account id", pattern: /\bACC-(?!EXAMPLE\b)[A-Za-z0-9][\w-]*/g },
  {
    name: "credential",
    pattern: /\b(?:pidgen|awes)_(?:cli|pat|enroll|worker)_[A-Za-z0-9]{8,}/g,
    allow: (text) => PLACEHOLDER_TOKEN.test(text),
  },
  {
    name: "credential",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|npm_[A-Za-z0-9]{30,})/g,
    allow: (text) => PLACEHOLDER_TOKEN.test(text),
  },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Each private match in `text`, with its 1-based line number. */
export function findPrivate(text) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const { name, pattern, allow } of PRIVATE_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        if (allow?.(match[0])) continue;
        found.push({ line: index + 1, kind: name, text: match[0] });
      }
    }
  });
  return found;
}

/**
 * The anchor GitHub gives a heading: the rendered text, lowercased, without punctuation other
 * than - and _, each space a hyphen (github-slugger). Duplicates are numbered by `anchorsOf`.
 */
export function githubSlug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+([^_]+?)_+(?=[^\p{L}\p{N}]|$)/gu, "$1$2")
    .trim();
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Splits Markdown into lines, marking those inside fenced code blocks (the fence lines included).
 */
function scanLines(markdown) {
  const lines = markdown.split("\n").map((line) => line.replace(/\r$/, ""));
  let fence = null;
  return lines.map((text, index) => {
    const opening = FENCE.exec(text);
    if (fence === null) {
      if (opening) {
        fence = opening[1];
        return { text, number: index + 1, code: true };
      }
      return { text, number: index + 1, code: false };
    }
    if (
      opening &&
      opening[1][0] === fence[0] &&
      opening[1].length >= fence.length &&
      text.trim() === opening[1]
    ) {
      fence = null;
    }
    return { text, number: index + 1, code: true };
  });
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** The headings of a Markdown document, outside fenced code: `{ level, text, line }`. */
export function headingsOf(markdown) {
  const headings = [];
  const lines = scanLines(markdown);
  lines.forEach((line, index) => {
    if (line.code) return;
    const atx = ATX_HEADING.exec(line.text);
    if (atx) {
      headings.push({ level: atx[1].length, text: (atx[2] ?? "").trim(), line: line.number });
      return;
    }
    const previous = lines[index - 1];
    const underline = SETEXT_UNDERLINE.exec(line.text);
    if (
      underline &&
      previous &&
      !previous.code &&
      previous.text.trim() !== "" &&
      !ATX_HEADING.test(previous.text) &&
      !/^\s*(?:[-*+>|]|\d+[.)])/.test(previous.text)
    ) {
      headings.push({
        level: underline[1][0] === "=" ? 1 : 2,
        text: previous.text.trim(),
        line: previous.number,
      });
    }
  });
  return headings;
}

/** Every fragment a link may name in a Markdown document: heading slugs and HTML ids. */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const { text } of headingsOf(markdown)) {
    const slug = githubSlug(text);
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    anchors.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  for (const line of scanLines(markdown)) {
    if (line.code) continue;
    for (const match of line.text.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

const INLINE_LINK = /!?\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/d;
const HTML_LINK = /<(?:a|img)\s[^>]*\b(?:href|src)\s*=\s*["']([^"']*)["']/dgi;

/**
 * The link targets of a Markdown document, outside fenced code and inline code:
 * `{ target, line, start }`, `start` the target's offset in its line.
 */
export function linksOf(markdown) {
  const links = [];
  for (const line of scanLines(markdown)) {
    if (line.code) continue;
    // Inline code is blanked, not removed, so offsets still index the line.
    const text = line.text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (span) => " ".repeat(span.length));
    const found = [...text.matchAll(INLINE_LINK)];
    const definition = REFERENCE_DEFINITION.exec(text);
    if (definition) found.push(definition);
    found.push(...text.matchAll(HTML_LINK));
    for (const match of found) {
      links.push({ target: match[1], line: line.number, start: match.indices[1][0] });
    }
  }
  return links;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

async function kindOf(path) {
  try {
    const found = await stat(path);
    return found.isFile() ? "file" : found.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, base)));
    else if (entry.isFile()) files.push(toPosix(relative(base, path)));
  }
  return files.sort();
}

function lineOf(text, needle, occurrence = 0) {
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) return undefined;
  }
  return text.slice(0, index).split("\n").length;
}

/** Checks navigation.json: its shape, and that it lists each page but the landing page once. */
async function checkNavigation(root, pages, problems) {
  const file = NAVIGATION_FILE;
  let text;
  try {
    text = await readFile(join(root, file), "utf8");
  } catch {
    problems.push({ file, message: `${file} is missing` });
    return;
  }
  let navigation;
  try {
    navigation = JSON.parse(text);
  } catch (error) {
    problems.push({ file, message: `is not valid JSON: ${error.message}` });
    return;
  }
  if (navigation?.version !== 1) {
    problems.push({ file, message: `"version" must be 1` });
  }
  if (!Array.isArray(navigation?.groups)) {
    problems.push({ file, message: `"groups" must be an array` });
    return;
  }
  const listed = new Map();
  navigation.groups.forEach((group, g) => {
    if (typeof group?.title !== "string" || group.title.trim() === "") {
      problems.push({ file, message: `groups[${g}] has no "title"` });
    }
    if (!Array.isArray(group?.pages)) {
      problems.push({ file, message: `groups[${g}] has no "pages" array` });
      return;
    }
    group.pages.forEach((page, p) => {
      if (typeof page?.title !== "string" || page.title.trim() === "") {
        problems.push({ file, message: `groups[${g}].pages[${p}] has no "title"` });
      }
      if (typeof page?.path !== "string" || page.path === "") {
        problems.push({ file, message: `groups[${g}].pages[${p}] has no "path"` });
        return;
      }
      const occurrences = listed.get(page.path) ?? [];
      occurrences.push(group.title);
      listed.set(page.path, occurrences);
    });
  });
  const known = new Set(pages);
  for (const [path, groups] of listed) {
    const line = lineOf(text, JSON.stringify(path));
    if (!path.endsWith(".md") || path.startsWith("/") || path.split("/").includes("..")) {
      problems.push({ file, line, message: `${path} is not a page path (page.md)` });
    } else if (!known.has(path)) {
      problems.push({
        file,
        line,
        message: `${path} is listed in ${file} but ${path} does not exist`,
      });
    }
    if (groups.length > 1) {
      problems.push({
        file,
        line: lineOf(text, JSON.stringify(path), 1),
        message: `${path} is listed ${groups.length} times in ${file} (${groups.map((title) => JSON.stringify(title)).join(", ")}); list each page once`,
      });
    }
  }
  for (const page of pages) {
    if (page !== LANDING_PAGE && !listed.has(page)) {
      problems.push({ file: page, message: `is not listed in ${file}` });
    }
  }
}

/**
 * Checks the docs directory `dir` against the docs bundle contract. Returns each problem as
 * `{ file, line?, message }`, `file` relative to `dir`; none when the docs pass.
 */
export async function checkDocs(dir) {
  const root = resolve(dir);
  const problems = [];
  const files = await listFiles(root);
  const pages = files.filter((file) => file.endsWith(".md"));
  if (!pages.includes(LANDING_PAGE)) {
    problems.push({ file: LANDING_PAGE, message: "is missing: it is the bundle's landing page" });
  }
  await checkNavigation(root, pages, problems);

  const sources = new Map();
  for (const page of pages) sources.set(page, await readFile(join(root, page), "utf8"));
  const anchorCache = new Map();
  const anchorsFor = async (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(await readFile(path, "utf8")));
    return anchorCache.get(path);
  };

  for (const file of files) {
    if (!file.endsWith(".md") && !file.endsWith(".json")) continue;
    const text = sources.get(file) ?? (await readFile(join(root, file), "utf8"));
    for (const { line, kind, text: match } of findPrivate(text)) {
      problems.push({ file, line, message: `private material, ${kind}: ${JSON.stringify(match)}` });
    }
  }

  for (const [page, markdown] of sources) {
    const [first] = headingsOf(markdown);
    if (!first) {
      problems.push({ file: page, message: "has no '#' title heading" });
    } else if (first.level !== 1) {
      problems.push({
        file: page,
        line: first.line,
        message: `the first heading must be the page's '#' title, not a level ${first.level} heading`,
      });
    }

    const source = join(root, page);
    for (const { target, line } of linksOf(markdown)) {
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        continue;
      }
      if (target.startsWith("/")) {
        problems.push({
          file: page,
          line,
          message: `link ${target} is a site-absolute path; link pages relatively (page.md)`,
        });
        continue;
      }
      const hash = target.indexOf("#");
      let path = hash === -1 ? target : target.slice(0, hash);
      let fragment = hash === -1 ? undefined : target.slice(hash + 1);
      path = path.replace(/\?.*$/, "");
      try {
        path = decodeURIComponent(path);
        if (fragment !== undefined) fragment = decodeURIComponent(fragment);
      } catch {
        problems.push({ file: page, line, message: `link ${target} is not a valid URL` });
        continue;
      }
      const resolved = path === "" ? source : resolve(dirname(source), path);
      const inside = !toPosix(relative(root, resolved)).startsWith("..");
      // A link may name a repository directory outside the docs (../skills); packing links it.
      const kind = await kindOf(resolved);
      if (kind !== "file" && !(kind === "directory" && !inside)) {
        const where = inside ? "" : " (outside the docs directory)";
        problems.push({
          file: page,
          line,
          message: `link ${target}: ${path} does not exist${where}`,
        });
        continue;
      }
      if (fragment === undefined || fragment === "" || !resolved.endsWith(".md")) continue;
      if (!(await anchorsFor(resolved)).has(fragment)) {
        const name = path === "" ? page : path;
        problems.push({
          file: page,
          line,
          message: `link ${target}: ${name} has no heading with the anchor #${fragment}`,
        });
      }
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || 0);
  return problems;
}

/** The files a bundle of `dir` holds besides docs-bundle.json: navigation.json, README.md, pages. */
async function bundledFiles(root) {
  const navigation = JSON.parse(await readFile(join(root, NAVIGATION_FILE), "utf8"));
  const pages = navigation.groups.flatMap((group) => group.pages.map((page) => page.path));
  return [LANDING_PAGE, NAVIGATION_FILE, ...pages];
}

/**
 * Rewrites the links of `markdown`, the page `page` of the docs directory `root`, whose target is
 * not a file of the bundle (`bundled`, paths relative to `root`) to the public repository at the
 * tag v`version`: files to /blob/, directories to /tree/, fragments kept. Absolute URLs, links
 * inside the bundle and links in code are left as they are.
 */
export async function rewriteLinks(
  markdown,
  { root, page, bundled, version, repositoryRoot = REPOSITORY_ROOT },
) {
  const inBundle = new Set(bundled);
  const source = join(root, page);
  const byLine = new Map();
  for (const link of linksOf(markdown)) {
    const { target } = link;
    if (target === "" || target.startsWith("#") || target.startsWith("/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const hash = target.indexOf("#");
    const path = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
    const fragment = hash === -1 ? "" : target.slice(hash);
    const resolved = resolve(dirname(source), decodeURIComponent(path));
    if (inBundle.has(toPosix(relative(root, resolved)))) continue;
    const inRepository = toPosix(relative(repositoryRoot, resolved));
    if (inRepository === "" || inRepository.startsWith("..")) {
      throw new Error(`${page}:${link.line}: link ${target} leaves the repository`);
    }
    const kind = (await kindOf(resolved)) === "directory" ? "tree" : "blob";
    const url = `${REPOSITORY_URL}/${kind}/v${version}/${inRepository.split("/").map(encodeURIComponent).join("/")}${fragment}`;
    const edits = byLine.get(link.line) ?? [];
    edits.push({ start: link.start, end: link.start + target.length, url });
    byLine.set(link.line, edits);
  }
  return markdown
    .split("\n")
    .map((text, index) => {
      const edits = (byLine.get(index + 1) ?? []).sort((a, b) => b.start - a.start);
      for (const { start, end, url } of edits) text = text.slice(0, start) + url + text.slice(end);
      return text;
    })
    .join("\n");
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`${name}: the path is too long to pack`);
  const field = (offset, length, value) => header.write(value, offset, length, "utf8");
  const octal = (offset, length, value) =>
    field(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
  field(148, 8, " ".repeat(8));
  field(156, 1, "0");
  field(257, 8, "ustar\x0000");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

/** A gzipped ustar archive of `entries` (`{ name, data }`), each file dated `mtime` (seconds). */
export function tarGz(entries, mtime = 0) {
  const blocks = [];
  for (const { name, data } of entries) {
    const body = Buffer.from(data);
    blocks.push(tarHeader(name, body.length, mtime), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/**
 * Packs the docs directory `dir`, which must pass `checkDocs`, into `outDir`. Returns the archive's
 * path. `version` and `commit` name the release; `mtime` (seconds) dates the archive's files.
 */
export async function packDocs(
  dir,
  { version, commit, mtime = 0, outDir = ".", repositoryRoot = REPOSITORY_ROOT },
) {
  const root = resolve(dir);
  const bundled = await bundledFiles(root);
  const manifest = { format: 1, product: PRODUCT, version, commit, navigation: NAVIGATION_FILE };
  const entries = [{ name: MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` }];
  for (const file of bundled) {
    let data = await readFile(join(root, file), "utf8");
    if (file.endsWith(".md")) {
      data = await rewriteLinks(data, { root, page: file, bundled, version, repositoryRoot });
    }
    entries.push({ name: file, data });
  }
  await mkdir(outDir, { recursive: true });
  const archive = join(outDir, `pidgen-${PRODUCT}-docs-${version}.tar.gz`);
  await writeFile(archive, tarGz(entries, mtime));
  return archive;
}

/** The release the docs are packed for: package.json's version, and HEAD's commit and time. */
async function release() {
  const pkg = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  const { stdout } = await promisify(execFile)("git", ["log", "-1", "--format=%H %ct"], {
    cwd: REPOSITORY_ROOT,
  });
  const [commit, time] = stdout.trim().split(" ");
  return { version: pkg.version, commit, mtime: Number(time) };
}

const USAGE = [
  "usage: node scripts/docs-bundle.mjs check [dir]",
  "       node scripts/docs-bundle.mjs pack [dir] [--out <dir>]",
  "dir defaults to docs; pack writes to the current directory unless --out names another.",
].join("\n");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  let outDir;
  for (let index = 0; index < rest.length; index += 1) {
    if (command === "pack" && rest[index] === "--out" && index + 1 < rest.length) {
      outDir = rest[(index += 1)];
    } else if (rest[index].startsWith("-")) {
      return undefined;
    } else {
      positional.push(rest[index]);
    }
  }
  if (!["check", "pack"].includes(command) || positional.length > 1) return undefined;
  return { command, dir: positional[0] ?? "docs", outDir: outDir ?? "." };
}

/** Runs the command line `argv` (without node and the script). Returns the exit code. */
export async function main(
  argv,
  { out = (line) => console.log(line), err = (line) => console.error(line) } = {},
) {
  const args = parseArgs(argv);
  if (args === undefined) {
    err(USAGE);
    return 2;
  }
  const { command, dir, outDir } = args;
  let problems;
  try {
    problems = await checkDocs(dir);
  } catch (error) {
    err(`Docs check failed: cannot read ${dir}: ${error.message}`);
    return 1;
  }
  const label = toPosix(dir).replace(/\/+$/, "");
  if (problems.length > 0) {
    for (const { file, line, message } of problems) {
      err(`${label}/${file}${line === undefined ? "" : `:${line}`}: ${message}`);
    }
    err(`Docs check failed: ${problems.length} problem(s) in ${label}.`);
    if (command === "pack") err("Docs pack failed: no archive written.");
    return 1;
  }
  if (command === "pack") {
    try {
      const archive = await packDocs(dir, { ...(await release()), outDir });
      out(`Docs bundle written: ${toPosix(archive)}`);
      return 0;
    } catch (error) {
      err(`Docs pack failed: ${error.message}`);
      return 1;
    }
  }
  const pages = (await listFiles(resolve(dir))).filter((file) => file.endsWith(".md")).length;
  out(`Docs check passed: ${label} (${pages} pages) meets the docs bundle contract.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
