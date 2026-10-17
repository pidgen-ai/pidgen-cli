export interface DocsProblem {
  /** The file the problem is in, relative to the docs directory, with / separators. */
  file: string;
  /** The 1-based line, when the problem has one. */
  line?: number;
  message: string;
}

export interface PrivateMatch {
  line: number;
  /** Which pattern matched, e.g. "localhost address". */
  kind: string;
  text: string;
}

export declare const LANDING_PAGE: "README.md";
export declare const NAVIGATION_FILE: "navigation.json";
export declare const MANIFEST_FILE: "docs-bundle.json";
export declare const PRODUCT: "cli";
export declare const REPOSITORY_URL: string;

export declare const PRIVATE_PATTERNS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  allow?: (text: string) => boolean;
}>;

export declare function findPrivate(text: string): PrivateMatch[];

/** The anchor GitHub gives a heading's text (without duplicate numbering). */
export declare function githubSlug(heading: string): string;

export declare function headingsOf(
  markdown: string,
): Array<{ level: number; text: string; line: number }>;

export declare function anchorsOf(markdown: string): Set<string>;

/** Link targets outside code; `start` is the target's offset in its line. */
export declare function linksOf(
  markdown: string,
): Array<{ target: string; line: number; start: number }>;

/** Checks a docs directory against the docs bundle contract; no problems when it passes. */
export declare function checkDocs(dir: string): Promise<DocsProblem[]>;

export declare function main(
  argv: string[],
  io?: { out?: (line: string) => void; err?: (line: string) => void },
): Promise<number>;

/** Rewrites links whose target is not in the bundle to the public repository at tag v<version>. */
export declare function rewriteLinks(
  markdown: string,
  options: {
    root: string;
    page: string;
    bundled: string[];
    version: string;
    repositoryRoot?: string;
  },
): Promise<string>;

/** A gzipped ustar archive of `entries`, each file dated `mtime` (seconds since the epoch). */
export declare function tarGz(
  entries: Array<{ name: string; data: string | Uint8Array }>,
  mtime?: number,
): Buffer;

/** Packs a docs directory that passes `checkDocs` into `outDir`; returns the archive's path. */
export declare function packDocs(
  dir: string,
  options: {
    version: string;
    commit: string;
    mtime?: number;
    outDir?: string;
    repositoryRoot?: string;
  },
): Promise<string>;
