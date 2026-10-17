import { Option, type Command } from "commander";
import type { GlobalOptions, RunContext } from "./context.js";
import type { PreviewApplyOptions } from "./preview.js";

/** Add the common preview/apply flags to a command that can change server state. */
export function addPreviewApplyOptions(command: Command): Command {
  return command
    .option("--apply", "apply the previewed change")
    .option("--digest <d>", "apply exactly this preview digest")
    .addOption(
      new Option("--ack <code>", "acknowledge a condition from the preview")
        .argParser(appendValue)
        .default([]),
    )
    .option("--reason <text>", "record a reason for the change")
    .option("--idempotency-key <key>", "set the apply idempotency key")
    .option("--wait", "wait for the apply to settle", true)
    .option("--no-wait", "return as soon as the apply is accepted");
}

export interface PreviewApplyCommandInput {
  options: Record<string, unknown>;
  global: Pick<GlobalOptions, "timeoutSeconds">;
}

/** Translate commander and global options into the dependencies used by the preview/apply engine. */
export function previewApplyOptionsFrom(
  ctx: RunContext,
  input: PreviewApplyCommandInput,
): PreviewApplyOptions {
  const raw = input.options;
  return {
    apply: raw["apply"] === true,
    ...(typeof raw["digest"] === "string" ? { digest: raw["digest"] } : {}),
    acknowledgements: stringArray(raw["ack"]),
    ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
    ...(typeof raw["idempotencyKey"] === "string" ? { idempotencyKey: raw["idempotencyKey"] } : {}),
    wait: raw["wait"] !== false,
    timeoutMs: input.global.timeoutSeconds * 1000,
    sleep: ctx.sleep,
    now: ctx.now,
    ...(ctx.io.interactive ? { progress: (message: string) => ctx.io.stderr(`${message}\n`) } : {}),
  };
}

function appendValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
