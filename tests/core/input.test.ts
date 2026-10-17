import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { parseInput, readInput, validateBody, type OpenApiDocument } from "../../src/core/input.js";
import { tempDir, testContext } from "../support/context.js";

async function caught(run: () => unknown): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected a CliError");
}

const YAML_BODY = `# a ticket
title: Read request bodies
priority: 3
labels:
  - cli
  - "input"
acceptance_criteria:
  - statement: parses YAML
    priority: MUST
done: false
parent: null
`;

const JSON_BODY = JSON.stringify(
  {
    title: "Read request bodies",
    priority: 3,
    labels: ["cli", "input"],
    acceptance_criteria: [{ statement: "parses YAML", priority: "MUST" }],
    done: false,
    parent: null,
  },
  null,
  2,
);

const DOCUMENT: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Pidgen public API", version: "0.0.0" },
  paths: {
    "/api/v1/tickets": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/TicketCreate" } },
          },
        },
      },
      get: {},
    },
    "/api/v1/tickets/{ref}": {
      patch: { requestBody: { $ref: "#/components/requestBodies/TicketEdit" } },
    },
    "/api/v1/domains": {
      post: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Domain" } } },
        },
      },
    },
  },
  components: {
    requestBodies: {
      TicketEdit: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { title: { $ref: "#/components/schemas/Title" } },
              additionalProperties: false,
            },
          },
        },
      },
    },
    schemas: {
      Title: { type: "string", minLength: 3 },
      Priority: { type: "string", enum: ["MUST", "SHOULD", "MAY"] },
      Criterion: {
        type: "object",
        required: ["statement", "priority"],
        properties: {
          statement: { type: "string" },
          priority: { $ref: "#/components/schemas/Priority" },
        },
      },
      TicketCreate: {
        type: "object",
        required: ["title", "acceptance_criteria"],
        properties: {
          title: { $ref: "#/components/schemas/Title" },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          acceptance_criteria: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/Criterion" },
          },
          // A property named like a data keyword still holds a schema.
          default: { $ref: "#/components/schemas/Title" },
        },
      },
      Domain: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          children: { type: "array", items: { $ref: "#/components/schemas/Domain" } },
        },
      },
    },
  },
};

describe("readInput", () => {
  it("parses yaml and json files with the same content to the same value", async () => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    await writeFile(join(dir, "body.yaml"), YAML_BODY);
    await writeFile(join(dir, "body.yml"), YAML_BODY);
    await writeFile(join(dir, "body.json"), JSON_BODY);

    const yaml = await readInput(ctx, "body.yaml");
    const yml = await readInput(ctx, join(dir, "body.yml"));
    const json = await readInput(ctx, "body.json");

    expect(yaml.format).toBe("yaml");
    expect(json.format).toBe("json");
    expect(yaml.value).toEqual(json.value);
    expect(yml.value).toEqual(json.value);
    expect(json.value).toEqual(JSON.parse(JSON_BODY));
  });

  it("reports a yaml syntax error with exit 2, INPUT_INVALID and the line number", async () => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    await writeFile(join(dir, "bad.yaml"), "title: ok\nlabels:\n  - a\n  b: [unclosed\n");

    const error = await caught(() => readInput(ctx, "bad.yaml"));
    expect(error.code).toBe("INPUT_INVALID");
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.exitCode).toBe(2);
    expect(error.details).toMatchObject({ source: "bad.yaml", format: "yaml", line: 4 });
    expect(error.details.column).toEqual(expect.any(Number));
    expect(error.message).toContain("line 4");
  });

  it.each([
    ['{\n  "title": "x",\n  "priority": }\n', 3, 15],
    ['{\n  "title": "x"\n  "priority": 1\n}\n', 3, 3],
    ['{\n  "title": "x",\n', 3, 1],
    ["[1, 2]\n\nextra", 3, 1],
  ])("reports a json syntax error with the line number (%#)", async (text, line, column) => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    await writeFile(join(dir, "bad.json"), text);

    const error = await caught(() => readInput(ctx, "bad.json"));
    expect(error.code).toBe("INPUT_INVALID");
    expect(error.exitCode).toBe(2);
    expect(error.details).toMatchObject({ format: "json", line, column });
    expect(error.message).toContain(`line ${line}, column ${column}`);
  });

  it("reports a syntax error in standard input with the line number", async () => {
    const ctx = await testContext({ readStdin: async () => "a: 1\nb: : :\n" });
    const error = await caught(() => readInput(ctx, "-"));
    expect(error.code).toBe("INPUT_INVALID");
    expect(error.exitCode).toBe(2);
    expect(error.details).toMatchObject({ source: "-", line: 2 });
  });

  it("reads the body from standard input when the path is '-'", async () => {
    const yamlCtx = await testContext({ readStdin: async () => YAML_BODY });
    const jsonCtx = await testContext({ readStdin: async () => `  ${JSON_BODY}` });

    const yaml = await readInput(yamlCtx, "-");
    const json = await readInput(jsonCtx, "-");

    expect(yaml).toMatchObject({ source: "-", format: "yaml" });
    expect(json).toMatchObject({ source: "-", format: "json" });
    expect(yaml.value).toEqual(json.value);
  });

  it("does not read standard input for a file path", async () => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    await writeFile(join(dir, "body.json"), "{}");
    await expect(readInput(ctx, "body.json")).resolves.toMatchObject({ value: {} });
  });

  it("detects the format of a file without a known extension by content", async () => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    await writeFile(join(dir, "body.txt"), "title: x\n");
    await expect(readInput(ctx, "body.txt")).resolves.toMatchObject({
      format: "yaml",
      value: { title: "x" },
    });
  });

  it("refuses a missing file and an empty body with INPUT_INVALID", async () => {
    const dir = await tempDir();
    const ctx = await testContext({ cwd: dir });
    const missing = await caught(() => readInput(ctx, "missing.yaml"));
    expect(missing).toMatchObject({ code: "INPUT_INVALID", exitCode: 2 });
    expect(missing.details).toEqual({ source: "missing.yaml" });

    const empty = await caught(() => readInput({ ...ctx, readStdin: async () => " \n" }, "-"));
    expect(empty).toMatchObject({ code: "INPUT_INVALID", exitCode: 2 });
  });

  it("refuses duplicate yaml keys", async () => {
    const error = await caught(() => parseInput("a: 1\na: 2\n", "yaml", "dup.yaml"));
    expect(error).toMatchObject({ code: "INPUT_INVALID", exitCode: 2 });
    expect(error.details).toMatchObject({ line: 2 });
  });
});

describe("validateBody", () => {
  const valid = {
    title: "Read request bodies",
    priority: 3,
    acceptance_criteria: [{ statement: "parses YAML", priority: "MUST" }],
  };

  it("returns a valid body unchanged, keeping fields the schema does not name", () => {
    const body = { ...valid, extra: true };
    expect(validateBody(DOCUMENT, "POST", "/api/v1/tickets", body)).toBe(body);
  });

  it("lists schema issues with the path of every one", async () => {
    const error = await caught(() =>
      validateBody(DOCUMENT, "post", "/tickets", {
        title: "no",
        priority: 9,
        acceptance_criteria: [{ statement: "ok", priority: "MUST" }, { priority: "LATER" }],
        default: 5,
      }),
    );
    expect(error.code).toBe("INPUT_INVALID");
    expect(error.exitCode).toBe(2);
    const issues = error.details.issues as { path: string; message: string }[];
    expect(issues.map((issue) => issue.path).sort()).toEqual(
      [
        "$.title",
        "$.priority",
        "$.acceptance_criteria[1].statement",
        "$.acceptance_criteria[1].priority",
        "$.default",
      ].sort(),
    );
    for (const issue of issues) expect(issue.message).toEqual(expect.any(String));
    expect(error.message).toContain("5 issues");
  });

  it("reports schema issues at the root of the body", async () => {
    const error = await caught(() =>
      validateBody(DOCUMENT, "POST", "/tickets", ["not", "an", "object"]),
    );
    expect(error.details.issues).toEqual([{ path: "$", message: expect.any(String) }]);
  });

  it("resolves $ref in schemas, request bodies and recursive schemas", async () => {
    // $ref to a shared request body, whose schema refers to a component schema.
    expect(validateBody(DOCUMENT, "PATCH", "/tickets/PIDGEN-12", { title: "Longer" })).toEqual({
      title: "Longer",
    });
    const edit = await caught(() =>
      validateBody(DOCUMENT, "PATCH", "/api/v1/tickets/{ref}", { title: "x", other: 1 }),
    );
    expect((edit.details.issues as { path: string }[]).map((issue) => issue.path).sort()).toEqual(
      ["$", "$.title"].sort(),
    );

    // A schema that refers to itself.
    const tree = { name: "root", children: [{ name: "a", children: [{ name: "b" }] }] };
    expect(validateBody(DOCUMENT, "POST", "/domains", tree)).toBe(tree);
    const deep = await caught(() =>
      validateBody(DOCUMENT, "POST", "/domains", { name: "root", children: [{ children: [{}] }] }),
    );
    expect((deep.details.issues as { path: string }[]).map((issue) => issue.path).sort()).toEqual(
      ["$.children[0].name", "$.children[0].children[0].name"].sort(),
    );
  });

  it("refuses an unresolvable or non-local $ref as an internal error", async () => {
    const broken: OpenApiDocument = {
      paths: {
        "/things": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } },
            },
          },
          put: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "https://example.com/s.json" } } },
            },
          },
        },
      },
    };
    const missing = await caught(() => validateBody(broken, "POST", "/things", {}));
    expect(missing).toMatchObject({ code: "CLI_INTERNAL", exitCode: ExitCode.Unexpected });
    const remote = await caught(() => validateBody(broken, "PUT", "/things", {}));
    expect(remote).toMatchObject({ code: "CLI_INTERNAL", exitCode: ExitCode.Unexpected });
  });

  it("refuses an operation outside the document or one without a request body", async () => {
    const unknown = await caught(() => validateBody(DOCUMENT, "DELETE", "/tickets", {}));
    expect(unknown).toMatchObject({ code: "CLI_USAGE", exitCode: 2 });
    const noBody = await caught(() => validateBody(DOCUMENT, "GET", "/tickets", {}));
    expect(noBody).toMatchObject({ code: "INPUT_INVALID", exitCode: 2 });
  });

  it("validates a body parsed from yaml", async () => {
    const ctx = await testContext({
      readStdin: async () => "title: Read request bodies\nacceptance_criteria: []\n",
    });
    const { value } = await readInput(ctx, "-");
    const error = await caught(() => validateBody(DOCUMENT, "POST", "/tickets", value));
    expect(error.details.issues).toEqual([
      { path: "$.acceptance_criteria", message: expect.any(String) },
    ]);
  });
});
