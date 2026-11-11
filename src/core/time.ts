/**
 * Times in human output: one formatter writes an instant in the machine's time zone in the Pidgen
 * house format ("Sun 25 Oct at 7:03 AM PDT"), and `localizeTimes` applies it to a response before
 * it is rendered for a person. JSON output never passes through here
 * (docs/output-and-exit-codes.md).
 */

type Row = Record<string, unknown>;

/** A full date, "T", a time, then Z or ±hh:mm. A bare calendar date is not an instant. */
const INSTANT =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function isInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** The machine's zone as Intl resolves it, which honours TZ. */
export function machineZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    formatters.set(zone, found);
  }
  return found;
}

function parts(at: number, zone: string): Record<string, string> {
  return Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/**
 * "Sun 25 Oct at 7:03 AM PDT"; the year follows the month when it is not the current year in that
 * zone ("Tue 4 Mar 2025 at 10:05 AM PST"). A value that is not an instant is returned as it is.
 */
export function formatInstant(
  value: string,
  zone: string = machineZone(),
  now: number = Date.now(),
): string {
  if (!isInstant(value)) return value;
  const p = parts(Date.parse(value), zone);
  const year = p["year"] !== parts(now, zone)["year"] ? ` ${p["year"]}` : "";
  return `${p["weekday"]} ${p["day"]} ${p["month"]}${year} at ${p["hour"]}:${p["minute"]} ${p["dayPeriod"]} ${p["timeZoneName"]}`;
}

interface Moment {
  text: string;
  at: string;
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moments(value: unknown): Moment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.every(
    (item) =>
      isRecord(item) &&
      typeof item["text"] === "string" &&
      item["text"] !== "" &&
      typeof item["at"] === "string",
  );
  return valid ? (value as Moment[]) : undefined;
}

function replaceMoments(text: string, list: Moment[], zone: string, now: number): string {
  let result = text;
  for (const moment of list) {
    if (!isInstant(moment.at)) continue;
    result = result.split(moment.text).join(formatInstant(moment.at, zone, now));
  }
  return result;
}

/**
 * A copy of `data` for human output. In a record carrying `moments: [{text, at}]`, each text in that
 * record's own string fields becomes the rendering of its `at`, and `moments` is dropped. Then every
 * string that is an instant is formatted. Calendar dates and other values are kept as they are.
 */
export function localizeTimes(
  data: unknown,
  zone: string = machineZone(),
  now: number = Date.now(),
): unknown {
  if (typeof data === "string") return formatInstant(data, zone, now);
  if (Array.isArray(data)) return data.map((item) => localizeTimes(item, zone, now));
  if (!isRecord(data)) return data;
  const list = moments(data["moments"]);
  const result: Row = {};
  for (const [key, value] of Object.entries(data)) {
    if (list !== undefined && key === "moments") continue;
    const replaced =
      list !== undefined && typeof value === "string"
        ? replaceMoments(value, list, zone, now)
        : value;
    result[key] = localizeTimes(replaced, zone, now);
  }
  return result;
}

interface Failure {
  code: string;
  message: string;
  details: Row;
}

/**
 * A failure for human output: `error.details.moments` describes `error.message`, so its texts are
 * replaced there too; the details are localized as `localizeTimes` does.
 */
export function localizeFailure<T extends Failure>(
  error: T,
  zone: string = machineZone(),
  now: number = Date.now(),
): T {
  const list = moments(error.details["moments"]);
  return {
    ...error,
    message: list === undefined ? error.message : replaceMoments(error.message, list, zone, now),
    details: localizeTimes(error.details, zone, now) as Row,
  };
}
