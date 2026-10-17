/**
 * Process exit codes. Public contract: see docs/output-and-exit-codes.md.
 * Renumbering or removing one is a major release.
 */
export const ExitCode = {
  Ok: 0,
  Unexpected: 1,
  Usage: 2,
  Auth: 3,
  NotFound: 4,
  Refused: 5,
  ConfirmationRequired: 6,
  VersionIncompatible: 7,
  Network: 8,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
