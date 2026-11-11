import { describe, expect, it } from "vitest";
import {
  formatInstant,
  isInstant,
  localizeFailure,
  localizeTimes,
  machineZone,
} from "../../src/core/time.js";

// z5-format: the one formatter for times in human output, in the house format.

const NOW = Date.parse("2026-10-25T00:00:00Z");
const LA = "America/Los_Angeles";

describe("formatInstant", () => {
  it("the test process runs in America/Los_Angeles (vitest.config.ts), so no test assumes UTC", () => {
    expect(process.env["TZ"]).toBe(LA);
    expect(machineZone()).toBe(LA);
  });

  it("writes an instant in the machine's zone by default: Sun 25 Oct at 7:03 AM PDT", () => {
    expect(formatInstant("2026-10-25T14:03:00Z", undefined, NOW)).toBe("Sun 25 Oct at 7:03 AM PDT");
  });

  it("writes standard time with its own short name (PST)", () => {
    expect(formatInstant("2026-12-01T17:30:00Z", LA, NOW)).toBe("Tue 1 Dec at 9:30 AM PST");
  });

  it("writes midnight as 12:00 AM and noon as 12:00 PM", () => {
    expect(formatInstant("2026-10-26T07:00:00Z", LA, NOW)).toBe("Mon 26 Oct at 12:00 AM PDT");
    expect(formatInstant("2026-10-26T19:00:00Z", LA, NOW)).toBe("Mon 26 Oct at 12:00 PM PDT");
  });

  it("adds the year when it is not the current year", () => {
    expect(formatInstant("2025-03-04T18:05:00Z", LA, NOW)).toBe("Tue 4 Mar 2025 at 10:05 AM PST");
    expect(formatInstant("2027-01-02T20:00:00Z", LA, NOW)).toBe("Sat 2 Jan 2027 at 12:00 PM PST");
  });

  it("the current year is the zone's: New Year's Eve in Los Angeles is still the old year", () => {
    const newYearUtc = Date.parse("2027-01-01T03:00:00Z");
    expect(formatInstant("2026-12-31T20:00:00Z", LA, newYearUtc)).toBe(
      "Thu 31 Dec at 12:00 PM PST",
    );
  });

  it("writes a zone with no abbreviation by its offset (Asia/Dubai → GMT+4)", () => {
    expect(formatInstant("2026-10-25T14:03:00Z", "Asia/Dubai", NOW)).toBe(
      "Sun 25 Oct at 6:03 PM GMT+4",
    );
  });

  it("reads an instant with an offset", () => {
    expect(formatInstant("2026-10-25T16:03:00+02:00", LA, NOW)).toBe("Sun 25 Oct at 7:03 AM PDT");
    expect(formatInstant("2026-10-25T14:03:00.123Z", LA, NOW)).toBe("Sun 25 Oct at 7:03 AM PDT");
  });
});

describe("isInstant", () => {
  it("is true only for a full date, T, a time, then Z or ±hh:mm", () => {
    expect(isInstant("2026-10-25T14:03:00Z")).toBe(true);
    expect(isInstant("2026-10-25T14:03:00.5+05:30")).toBe(true);
    expect(isInstant("2026-10-25T14:03Z")).toBe(true);
    expect(isInstant("2026-10-15")).toBe(false);
    expect(isInstant("2026-10-25T14:03:00")).toBe(false);
    expect(isInstant("due 2026-10-25T14:03:00Z")).toBe(false);
    expect(isInstant("2026-10-25 14:03:00Z")).toBe(false);
    expect(isInstant("2026-13-45T99:99:00Z")).toBe(false);
  });
});

// z5-instants and z5-moments: the pure transform human output applies before rendering.
describe("localizeTimes", () => {
  it("formats instants anywhere and leaves calendar dates, sentences with dates and other values", () => {
    const data = {
      created_at: "2026-10-25T14:03:00Z",
      target_date: "2026-10-15",
      note: "due 2026-10-15T00:00:00Z or so",
      count: 3,
      flag: true,
      empty: null,
      nested: { list: ["2026-12-01T17:30:00Z", "plain"] },
    };
    const copy = structuredClone(data);
    expect(localizeTimes(data, LA, NOW)).toEqual({
      created_at: "Sun 25 Oct at 7:03 AM PDT",
      target_date: "2026-10-15",
      note: "due 2026-10-15T00:00:00Z or so",
      count: 3,
      flag: true,
      empty: null,
      nested: { list: ["Tue 1 Dec at 9:30 AM PST", "plain"] },
    });
    expect(data).toEqual(copy);
  });

  it("replaces each moment's text in the record's string fields and drops moments", () => {
    const entry = {
      occurred_at: "2026-10-25T14:03:00Z",
      summary: "Worker offline since Sun 25 Oct at 2:03 PM UTC; retried Sun 25 Oct at 2:03 PM UTC",
      reason: "Paused at Tue 1 Dec at 5:30 PM UTC",
      moments: [
        { text: "Sun 25 Oct at 2:03 PM UTC", at: "2026-10-25T14:03:00Z" },
        { text: "Tue 1 Dec at 5:30 PM UTC", at: "2026-12-01T17:30:00Z" },
        { text: "words not in any sentence", at: "2026-12-01T17:30:00Z" },
      ],
    };
    expect(localizeTimes({ entries: [entry] }, LA, NOW)).toEqual({
      entries: [
        {
          occurred_at: "Sun 25 Oct at 7:03 AM PDT",
          summary:
            "Worker offline since Sun 25 Oct at 7:03 AM PDT; retried Sun 25 Oct at 7:03 AM PDT",
          reason: "Paused at Tue 1 Dec at 9:30 AM PST",
        },
      ],
    });
  });

  it("does not replace a moment in another record", () => {
    const data = {
      summary: "At Sun 25 Oct at 2:03 PM UTC",
      child: {
        reason: "Since Sun 25 Oct at 2:03 PM UTC",
        moments: [{ text: "Sun 25 Oct at 2:03 PM UTC", at: "2026-10-25T14:03:00Z" }],
      },
    };
    expect(localizeTimes(data, LA, NOW)).toEqual({
      summary: "At Sun 25 Oct at 2:03 PM UTC",
      child: { reason: "Since Sun 25 Oct at 7:03 AM PDT" },
    });
  });

  it("shows a record whose moments are not {text, at} objects as written", () => {
    const data = { summary: "x", moments: ["not a moment"] };
    expect(localizeTimes(data, LA, NOW)).toEqual(data);
  });
});

describe("localizeFailure", () => {
  it("replaces moments from error.details.moments in the message and the details", () => {
    const error = {
      code: "WORKER_OFFLINE",
      message: "The worker is offline since Sun 25 Oct at 2:03 PM UTC.",
      details: {
        status: 409,
        retry_at: "2026-10-25T15:00:00Z",
        moments: [{ text: "Sun 25 Oct at 2:03 PM UTC", at: "2026-10-25T14:03:00Z" }],
      },
    };
    expect(localizeFailure(error, LA, NOW)).toEqual({
      code: "WORKER_OFFLINE",
      message: "The worker is offline since Sun 25 Oct at 7:03 AM PDT.",
      details: { status: 409, retry_at: "Sun 25 Oct at 8:00 AM PDT" },
    });
    expect(error.details.moments).toHaveLength(1);
  });

  it("leaves a failure without moments as written, instants aside", () => {
    const error = { code: "X", message: "No 2026-10-25T14:03:00Z here.", details: { a: "b" } };
    expect(localizeFailure(error, LA, NOW)).toEqual(error);
  });
});
