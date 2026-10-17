/** Each operation a command sends: method, path, and the commands that send it. */
export declare const COMMAND_OPERATIONS: ReadonlyArray<
  readonly [method: string, path: string, commands: readonly string[]]
>;

/** The API coverage report as Markdown, for a parsed public API document. */
export declare function renderCoverage(document: {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
}): string;
