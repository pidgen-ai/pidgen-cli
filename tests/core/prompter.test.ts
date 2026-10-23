import { join } from "node:path";
import { PassThrough } from "node:stream";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clackPrompter, PromptCancelled, type Prompter } from "../../src/core/prompter.js";
import { tempDir } from "../support/temp.js";

const ROOT = join(import.meta.dirname, "..", "..");

/** The real prompter on fake streams: keys go in, the drawn frames come out (ANSI stripped). */
async function terminal(): Promise<{
  prompter: Prompter;
  keys: (...keys: string[]) => Promise<void>;
  screen: () => string;
}> {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 40 });
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const prompter = await clackPrompter({ input, output });
  opened.push(prompter);
  return {
    prompter,
    keys: async (...keys) => {
      for (const key of keys) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        input.write(key);
      }
    },
    // eslint-disable-next-line no-control-regex
    screen: () => chunks.join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""),
  };
}

describe("clackPrompter", () => {
  // prompts-seam: the real prompter wraps clack's prompts.
  it("a multiselect takes space and Enter, and collapses to its one line", async () => {
    const t = await terminal();
    const answer = t.prompter.multiselect({
      message: "Which coding agents will this worker run?",
      options: [
        { value: "claude", label: "Claude Code", hint: "on this machine" },
        { value: "codex", label: "Codex", hint: "not installed · setup installs it with npm" },
      ],
      initialValues: ["claude"],
      required: "Choose at least one.",
      collapse: (values) => `Coding agents · ${values.join(", ")}`,
    });
    await t.keys("\u001b[B", " ", "\r");

    expect(await answer).toEqual(["claude", "codex"]);
    expect(t.screen()).toContain("◆  Which coding agents will this worker run?");
    expect(t.screen()).toContain("◇  Coding agents · claude, codex");
  });

  it("a multiselect confirmed with none stays open with the required message", async () => {
    const t = await terminal();
    const answer = t.prompter.multiselect({
      message: "Which coding agents will this worker run?",
      options: [{ value: "claude", label: "Claude Code" }],
      required: "Choose at least one.",
    });
    await t.keys("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.screen()).toContain("▲  Choose at least one.");
    await t.keys(" ", "\r");

    expect(await answer).toEqual(["claude"]);
  });

  it("a select starts on its initial value; a text prompt validates; a confirm takes y", async () => {
    const t = await terminal();
    const select = t.prompter.select({
      message: "Claude Code: how many sessions should run at once?",
      options: [
        { value: 1, label: "1", hint: "Pro, or not sure" },
        { value: 2, label: "2", hint: "Max 5x" },
      ],
      initialValue: 2,
    });
    await t.keys("\r");
    expect(await select).toBe(2);

    const text = t.prompter.text({
      message: "Claude Code sessions at a time",
      validate: (value) =>
        /^[1-9]\d*$/.test(value) ? undefined : "Enter a whole number, 1 or more.",
    });
    await t.keys("0", "\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.screen()).toContain("▲  Enter a whole number, 1 or more.");
    await t.keys("\u007f", "6", "\r");
    expect(await text).toBe("6");

    const confirm = t.prompter.confirm({ message: "Install it?", initialValue: false });
    await t.keys("y");
    expect(await confirm).toBe(true);
  });

  // prompts-cancel: Ctrl-C at a prompt.
  it("Ctrl-C at a prompt rejects with PromptCancelled", async () => {
    const t = await terminal();
    const answer = t.prompter.confirm({ message: "Install it?" });
    await t.keys("\u0003");

    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
  });
});

/**
 * A terminal that may stop reading: `backlog` is what the CLI has queued for it and not yet
 * written (the output's `writableLength`), as a non-blocking terminal handle keeps it.
 */
async function slowTerminal() {
  const blocking: boolean[] = [];
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean) => void raw.push(on),
  });
  const chunks: string[] = [];
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 80,
    rows: 40,
    backlog: 0,
    _handle: { setBlocking: (on: boolean) => void blocking.push(on) },
  });
  Object.defineProperty(output, "writableLength", { get: () => output.backlog });
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const prompter = await clackPrompter({ input, output });
  opened.push(prompter);
  return {
    prompter,
    input,
    output,
    blocking,
    raw,
    chunks,
    // eslint-disable-next-line no-control-regex
    screen: () => chunks.join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""),
  };
}

const opened: Prompter[] = [];
afterEach(async () => {
  for (const prompter of opened.splice(0)) await prompter.close();
  vi.restoreAllMocks();
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// AC-2065505d2988: terminal output never blocks setup's event loop.
describe("clackPrompter output", () => {
  it("puts the terminal handle in non-blocking mode for the whole run", async () => {
    const t = await slowTerminal();
    expect(t.blocking).toEqual([false]);
  });

  it("skips spinner frames while output is queued, and always writes the result line", async () => {
    const t = await slowTerminal();
    const spin = t.prompter.spinner();
    spin.start("Checking this machine…");
    await tick(300);
    const drawn = t.chunks.length;
    expect(t.screen()).toContain("Checking this machine");

    t.output.backlog = 200;
    await tick(400);
    // Nothing more queued for a terminal that is not reading: at most the one pending frame.
    expect(t.chunks.length).toBe(drawn);

    spin.stop("This machine is ready");
    expect(t.screen()).toContain("◇  This machine is ready");
    t.output.backlog = 0;
  });

  it("skips the wait's live line while output is queued, and always writes its end", async () => {
    const t = await slowTerminal();
    const wait = t.prompter.wait({
      message: "Waiting for you to approve in the browser…",
      keys: "Enter open in browser · n new code · Esc other options",
    });
    await tick(200);
    expect(t.screen()).toContain("Waiting for you to approve in the browser…");
    expect(t.screen()).toContain("Enter open in browser · n new code · Esc other options");
    t.output.backlog = 200;
    const drawn = t.chunks.length;
    wait.update("Waiting for you to approve in the browser… 1m 12s · checked 2s ago");
    await tick(300);
    expect(t.chunks.length).toBe(drawn);
    t.output.backlog = 0;
    await tick(200);
    expect(t.screen()).toContain("1m 12s · checked 2s ago");
    wait.stop("Signed in as person@example.com");
    expect(t.screen()).toContain("◇  Signed in as person@example.com");
  });
});

// AC-c16d531ac9ab: Ctrl-C and SIGTERM during a spinner or the wait stop setup through its own
// handlers; nothing calls process.exit.
describe("clackPrompter interrupts", () => {
  it("Ctrl-C during a spinner is reported as an interrupt, and never exits the process", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const t = await slowTerminal();
    const heard: string[] = [];
    t.prompter.onInterrupt((reason) => heard.push(reason));
    const spin = t.prompter.spinner();
    spin.start("Installing pidgen-worker 1.0.0…");
    expect(t.raw.at(-1)).toBe(true);
    t.input.write("\u0003");
    await tick(20);
    expect(heard).toEqual(["ctrl-c"]);
    expect(exit).not.toHaveBeenCalled();
    spin.clear();
    expect(t.raw.at(-1)).toBe(false);
  });

  it("SIGTERM during a spinner is reported as an interrupt, and SIGINT as Ctrl-C", async () => {
    const t = await slowTerminal();
    const heard: string[] = [];
    t.prompter.onInterrupt((reason) => heard.push(reason));
    const spin = t.prompter.spinner();
    spin.start("Checking this machine…");
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    expect(heard).toEqual(["sigterm", "ctrl-c"]);
    spin.clear();
  });

  it("close removes its signal handlers", async () => {
    const before = process.listenerCount("SIGTERM");
    const t = await slowTerminal();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await t.prompter.close();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

// AC-a7746e57d065: the wait answers Enter, n and Esc; Ctrl-C interrupts.
describe("clackPrompter wait", () => {
  it("answers Enter, n and Esc as keys, and Ctrl-C as an interrupt", async () => {
    const t = await slowTerminal();
    const heard: string[] = [];
    t.prompter.onInterrupt((reason) => heard.push(reason));
    const wait = t.prompter.wait({ message: "Waiting…", keys: "Enter open in browser" });
    const keys: string[] = [];
    for (const key of ["\r", "n", "\u001b"]) {
      const next = wait.key();
      t.input.write(key);
      keys.push(await next);
    }
    expect(keys).toEqual(["enter", "new", "escape"]);
    // An arrow key is not Esc.
    let pressed = false;
    void wait.key().then(() => (pressed = true));
    t.input.write("\u001b[A");
    await tick(20);
    expect(pressed).toBe(false);
    t.input.write("\u0003");
    await tick(20);
    expect(heard).toEqual(["ctrl-c"]);
    wait.clear();
    expect(t.raw.at(-1)).toBe(false);
  });
});

// prompts-seam: only setup loads clack, so `pidgen --version` and every other command do not.
describe("the bundle", () => {
  it("does not import @clack/core at its top level, only dynamically, and never @clack/prompts", async () => {
    const outdir = await tempDir("pidgen-bundle-");
    // As tsup builds it (tsup.config.ts): one ESM bundle, packages left as imports.
    const result = await build({
      entryPoints: { pidgen: join(ROOT, "src", "bin", "pidgen.ts") },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      splitting: true,
      packages: "external",
      define: { __PIDGEN_VERSION__: JSON.stringify("0.0.0-test") },
      outdir,
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const outputs = Object.entries(result.metafile.outputs);
    expect(outputs.some(([, output]) => output.entryPoint !== undefined)).toBe(true);
    // No output imports clack statically, so loading the bundle never loads it.
    for (const [path, output] of outputs) {
      const clack = output.imports.filter(
        (entryImport) =>
          entryImport.kind === "import-statement" && /^@clack\//.test(entryImport.path),
      );
      expect(clack, path).toEqual([]);
    }
    // It is loaded: dynamically.
    const dynamic = outputs.flatMap(([, output]) =>
      output.imports.filter((entryImport) => entryImport.kind === "dynamic-import"),
    );
    expect(dynamic.map((entryImport) => entryImport.path)).toEqual(
      expect.arrayContaining(["@clack/core"]),
    );
    // Setup draws its own spinners: clack's spinner, which exits the process on Ctrl-C, is gone.
    const all = outputs.flatMap(([, output]) => output.imports.map((entry) => entry.path));
    expect(all).not.toContain("@clack/prompts");
  });
});
