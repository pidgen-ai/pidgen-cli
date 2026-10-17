import { usageError } from "./errors.js";

const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * A ticket reference given on the command line (a key such as `PIDGEN-12`, or an id), checked so it
 * names exactly one path segment and cannot reach another route. A missing or malformed reference
 * is a usage error (`CLI_USAGE`, exit code 2) and nothing is sent.
 */
export function ticketRef(value: string | undefined, argument = "<ref>"): string {
  if (value === undefined || value.trim() === "") {
    throw usageError(`Missing ticket reference ${argument}, e.g. PIDGEN-12.`, { argument });
  }
  if (!REF.test(value) || value.includes("..")) {
    throw usageError(`Not a ticket reference: "${value}". Give a ticket key such as PIDGEN-12.`, {
      argument,
      value,
    });
  }
  return value;
}
