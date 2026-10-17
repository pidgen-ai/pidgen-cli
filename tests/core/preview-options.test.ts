import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { emptyMeta, render, success } from "../../src/core/envelope.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../src/core/preview-options.js";
import {
  runPreviewApply,
  type Outcome,
  type PreviewApplyOperation,
} from "../../src/core/preview.js";
import { testContext, type TestContext } from "../support/context.js";

function fakeOperation(applyOutcome: Outcome = { settled: true, result: { status: "applied" } }) {
  return {
    command: "ticket retry",
    target: "PIDGEN-4",
    preview: vi.fn(async () => ({
      preview_digest: "sha256:preview",
      required_acknowledgements: ["reviewed"],
      plan: { action: "retry" },
    })),
    apply: vi.fn(async () => applyOutcome),
    status: vi.fn(async () => ({ settled: true, result: { status: "applied" } })),
  } satisfies PreviewApplyOperation;
}

async function parsedOptions(ctx: TestContext, argv: string[], timeoutSeconds = 120) {
  const command = addPreviewApplyOptions(new Command("fake").exitOverride());
  await command.parseAsync(argv, { from: "user" });
  return previewApplyOptionsFrom(ctx, {
    options: command.opts<Record<string, unknown>>(),
    global: { timeoutSeconds },
  });
}

describe("shared preview/apply command options", () => {
  it("maps flags onto PreviewApplyOptions", async () => {
    const ctx = await testContext();
    const defaults = await parsedOptions(ctx, [], 17);
    const options = await parsedOptions(
      ctx,
      [
        "--apply",
        "--digest",
        "sha256:preview",
        "--ack",
        "reviewed",
        "--reason",
        "operator request",
        "--idempotency-key",
        "key-1",
        "--no-wait",
      ],
      17,
    );

    expect(defaults).toMatchObject({
      apply: false,
      acknowledgements: [],
      wait: true,
      timeoutMs: 17_000,
    });
    expect(options).toMatchObject({
      apply: true,
      digest: "sha256:preview",
      acknowledgements: ["reviewed"],
      reason: "operator request",
      idempotencyKey: "key-1",
      wait: false,
      timeoutMs: 17_000,
      sleep: ctx.sleep,
      now: ctx.now,
    });
  });

  it("supports repeatable ack flags", async () => {
    const ctx = await testContext();
    const options = await parsedOptions(ctx, ["--ack", "reviewed", "--ack", "completed-source"]);

    expect(options.acknowledgements).toEqual(["reviewed", "completed-source"]);
  });

  it("honors --no-wait by returning without polling", async () => {
    const ctx = await testContext();
    const op = fakeOperation({ settled: false, result: { status: "accepted" }, handle: "req-1" });
    const options = await parsedOptions(ctx, [
      "--apply",
      "--digest",
      "sha256:preview",
      "--no-wait",
    ]);

    await expect(runPreviewApply(op, options)).resolves.toMatchObject({
      mode: "apply",
      settled: false,
      handle: "req-1",
    });
    expect(op.status).not.toHaveBeenCalled();
  });

  it("writes progress to stderr only for an interactive terminal", async () => {
    for (const interactive of [true, false]) {
      const ctx = await testContext();
      ctx.io.interactive = interactive;
      const op = fakeOperation({
        settled: false,
        result: { status: "accepted" },
        handle: "req-1",
      });
      const options = await parsedOptions(ctx, ["--apply", "--digest", "sha256:preview"]);

      await runPreviewApply(op, options);

      expect(ctx.out).toEqual([]);
      expect(ctx.err).toEqual(interactive ? ["Waiting for operation req-1 to settle...\n"] : []);
    }
  });

  it("runs a fake command that previews by default and prints the preview envelope", async () => {
    const ctx = await testContext();
    const op = fakeOperation();
    const command = addPreviewApplyOptions(new Command("fake").exitOverride());
    command.action(async () => {
      const result = await runPreviewApply(
        op,
        previewApplyOptionsFrom(ctx, {
          options: command.opts<Record<string, unknown>>(),
          global: { timeoutSeconds: 120 },
        }),
      );
      const data = result.mode === "preview" ? result.preview : result.result;
      ctx.io.stdout(render(success(data, emptyMeta()), "json"));
    });

    await command.parseAsync([], { from: "user" });

    expect(JSON.parse(ctx.out.join(""))).toMatchObject({
      ok: true,
      data: {
        preview_digest: "sha256:preview",
        required_acknowledgements: ["reviewed"],
        plan: { action: "retry" },
      },
      error: null,
    });
    expect(op.apply).not.toHaveBeenCalled();
  });
});
