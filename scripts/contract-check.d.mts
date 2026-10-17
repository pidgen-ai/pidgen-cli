export interface Citation {
  /** JSON pointer (RFC 6901) of the string value or member name that contains the match. */
  pointer: string;
  /** Which pattern matched, e.g. "ADR citation". */
  kind: string;
  /** The matched text. */
  text: string;
}

export declare const CITATION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }>;

export declare function findCitations(document: unknown): Citation[];

export interface PullOptions {
  base: string;
  file?: string;
  fetch?: (url: URL, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export declare function pullContract(options: PullOptions): Promise<number>;

/** Operations a pull leaves out although the server may still publish them, as `[method, path]`. */
export declare const RETIRED_OPERATIONS: ReadonlyArray<readonly [string, string]>;

export interface Pruned<T> {
  /** A copy of the document without the retired operations and the components only they used. */
  document: T;
  /** The retired operations left out, as `METHOD path`. */
  operations: string[];
  /** The component names left out, sorted. */
  schemas: string[];
}

export declare function pruneRetired<T extends { paths: Record<string, unknown> }>(
  document: T,
): Pruned<T>;
