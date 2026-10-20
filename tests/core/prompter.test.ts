import { join } from "node:path";
import { PassThrough } from "node:stream";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
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

// prompts-seam: only setup loads clack, so `pidgen --version` and every other command do not.
describe("the bundle", () => {
  it("does not import @clack/prompts or @clack/core at its top level, only dynamically", async () => {
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
      expect.arrayContaining(["@clack/prompts", "@clack/core"]),
    );
  });
});
