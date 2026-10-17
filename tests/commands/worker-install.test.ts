import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { WORKER_RELEASE_IDENTITIES } from "../../src/core/worker-release-identities.js";
import { envelope, jsonResponse } from "../support/context.js";
import {
  fixture,
  installContext,
  PREVIOUS_WHEEL,
  previousInstall,
  PROVENANCE_URL,
  PYPI_JSON_URL,
  RECORDED_WHEEL,
  RELEASES_URL,
  releaseList,
  TEST_PROVENANCE_URL,
  TEST_PYPI_JSON_URL,
  TEST_IDENTITY,
  TEST_ISSUER,
  TEST_SUBJECT,
  WHEEL,
  WHEEL_SHA256,
  type IndexFile,
  type InstallContext,
} from "../support/worker-install.js";

const DIGEST = `sha256:${WHEEL_SHA256}`;

async function listFiles(directory: string): Promise<string[]> {
  try {
    return await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
}

async function readRecord(pidgenHome: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(pidgenHome, "run", "pidgen-install.json"), "utf8"));
}

/** A wheel the index lists for `version` that no test installs (it has no recorded provenance). */
function indexWheel(version: string): IndexFile {
  const filename = `pidgen_worker-${version}-py3-none-any.whl`;
  return {
    filename,
    url: `https://files.pythonhosted.org/packages/py3/p/pidgen-worker/${filename}`,
    digests: { sha256: "1".repeat(64) },
  };
}

/** The recorded 1.0.0 and a newer 1.0.1 of the same series. */
const NEWER_PATCH_INDEX = { "1.0.0": [RECORDED_WHEEL], "1.0.1": [indexWheel("1.0.1")] };

describe("pidgen worker install (wheel)", () => {
  // AC-13099f01c6dd: the human renderer leaves installation commands and progress on stderr.
  it.each(["json", "table"])(
    "keeps CLI-owned install progress on stderr with %s output",
    async (format) => {
      const setup = await installContext();
      setup.ctx.io.stdoutIsTTY = true;
      expect(await runCli(["worker", "install", "--format", format], setup.ctx)).toBe(ExitCode.Ok);
      const stderr = setup.ctx.err.join("");
      expect(stderr).toContain("tool install");
      expect(stderr).toContain(releaseList().eula.notice);
      expect(setup.ctx.out.join("")).not.toContain("$ ");
      if (format === "json")
        expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { installed: true } });
      else expect(setup.ctx.out.join("")).toContain("Worker installed.");
    },
  );

  // AC-c30e31951985: reads the release list with no credential, downloads the exact wheel,
  // verifies it with the provenance module, and only then runs `uv tool install <verified file>`.
  it("reads the release list without a credential, verifies the exact wheel, then installs that file with uv", async () => {
    const setup = await installContext({
      env: { PIDGEN_TOKEN: "pidgen_pat_example_not_a_token", PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
    });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);

    const release = setup.fetchCalls.find((call) => call.url === RELEASES_URL);
    expect(release).toBeDefined();
    expect(release!.headers).not.toHaveProperty("authorization");
    expect(release!.headers).not.toHaveProperty("x-pidgen-account");
    // The release list is read first; the wheel and its provenance come from PyPI after it.
    expect(setup.fetchCalls[0]!.url).toBe(RELEASES_URL);
    expect(setup.fetchCalls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/integrity/pidgen-worker/1.0.0/"),
        expect.stringContaining(WHEEL),
      ]),
    );

    const runs = await setup.uvRuns();
    const install = runs.find((run) => run.args[1] === "install");
    expect(install).toBeDefined();
    expect(install!.args.slice(0, 2)).toEqual(["tool", "install"]);
    const file = install!.args.at(-1)!;
    expect(basename(file)).toBe(WHEEL);
    // uv was given the very file that was verified.
    expect(install!.sha256).toBe(WHEEL_SHA256);

    const env = envelope(setup.ctx);
    expect(env).toMatchObject({
      ok: true,
      data: {
        form: "wheel",
        version: "1.0.0",
        artifact: "pidgen-worker==1.0.0",
        digest: DIGEST,
        identity: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
        location: join(setup.binDir, "pidgen-worker"),
        installed: true,
      },
    });
    const data = env["data"] as Record<string, unknown>;
    expect(typeof data["verified_at"]).toBe("string");
    expect(typeof data["installed_at"]).toBe("string");
  });

  it("refuses a wheel whose attestation was signed by another identity, and installs nothing", async () => {
    const setup = await installContext({ provenance: fixture("provenance-wrong-identity.json") });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { check: "identity" } },
    });
    expect((await setup.uvRuns()).filter((run) => run.args[1] === "install")).toEqual([]);
    expect(setup.spawns).toEqual([]);
    expect(await listFiles(join(setup.pidgenHome, "run"))).not.toContain("pidgen-install.json");
    expect((await listFiles(setup.pidgenHome)).filter((name) => name.endsWith(".whl"))).toEqual([]);
  });

  // AC-6a86a3fa9119: PROVENANCE_INVALID (5) leaving nothing installed.
  it("refuses a downloaded wheel that differs from the release digest, and installs nothing", async () => {
    const setup = await installContext({ wheel: Buffer.from("not the released wheel") });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { check: "digest" } },
    });
    expect(setup.spawns).toEqual([]);
    expect(await listFiles(setup.pidgenHome)).not.toContain(join("run", "pidgen-install.json"));
    expect((await listFiles(setup.pidgenHome)).filter((name) => name.endsWith(".whl"))).toEqual([]);
  });

  it("refuses a release with no attestation on PyPI before downloading it", async () => {
    const setup = await installContext({ provenanceStatus: 404 });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { check: "attestation" } },
    });
    expect(setup.fetchCalls.some((call) => call.url.endsWith(".whl"))).toBe(false);
    expect(setup.spawns).toEqual([]);
  });

  it("refuses with the release identity the CLI carries when no test identity is injected", async () => {
    // The production identity list holds the worker's release workflow; the fixture was signed by
    // a test identity, so a real install refuses until a release signed by that workflow exists.
    const setup = await installContext({
      trust: {
        identities: WORKER_RELEASE_IDENTITIES,
        trustedRoot: async () => fixture("trusted-root.json"),
      },
    });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      error: { code: "PROVENANCE_INVALID", details: { check: "identity" } },
    });
    expect(setup.spawns).toEqual([]);
  });

  it("installs the release named with --version", async () => {
    // 1.0.1 is the current series' newest release; --version picks the older 1.0.0.
    const setup = await installContext({ index: NEWER_PATCH_INDEX });

    expect(await runCli(["worker", "install", "--version", "1.0.0"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { version: "1.0.0" } });
  });

  // AC-0b628867aff9: every command is composed by the CLI, printed to standard error before it
  // runs, and run with an argument list, never through a shell.
  it("prints every command to standard error before running it, with an argument list and no shell", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);

    expect(setup.spawns.length).toBeGreaterThanOrEqual(1);
    for (const spawn of setup.spawns) {
      expect(spawn.command).toBe(join(setup.pathDir, "uv"));
      expect(spawn.command).not.toMatch(/(^|\/)(ba|z|da)?sh$/);
      expect(spawn.options.shell ?? false).toBe(false);
      const line = `$ ${[spawn.command, ...spawn.args].join(" ")}\n`;
      expect(spawn.stderrBefore).toContain(line);
    }
    const install = setup.spawns.find((spawn) => spawn.args[1] === "install")!;
    expect(install.args.slice(0, 2)).toEqual(["tool", "install"]);
    expect(install.args.at(-1)).toMatch(new RegExp(`${WHEEL.replace(/\./g, "\\.")}$`));
    expect(setup.ctx.out.join("")).not.toContain("$ ");
  });

  // AC-8b245945ccbd: the licence notice is printed before installing; no prompt and no flag.
  it("prints the licence notice before installing, and never asks", async () => {
    const setup = await installContext();
    const ask = vi.fn(async () => "y");
    setup.ctx.ask = ask;

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);

    const { eula } = releaseList();
    const install = setup.spawns.find((spawn) => spawn.args[1] === "install")!;
    expect(install.stderrBefore).toContain(eula.notice);
    expect(install.stderrBefore).toContain(eula.name);
    expect(install.stderrBefore).toContain(eula.location);
    const stderr = setup.ctx.err.join("");
    expect(stderr.indexOf(eula.notice)).toBeLessThan(stderr.indexOf(" tool install "));
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([["--accept-licence"], ["--accept-license"], ["--yes"], ["--no-licence"]])(
    "has no licence flag: %s is a usage error",
    async (flag) => {
      const setup = await installContext();

      expect(await runCli(["worker", "install", flag], setup.ctx)).toBe(ExitCode.Usage);
      expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
      expect(setup.spawns).toEqual([]);
      expect(setup.fetchCalls).toEqual([]);
    },
  );

  // AC-6ca30b094dd2: the install record is written beside the run record and returned as data;
  // reinstalling the recorded version is a no-op unless --force.
  it("writes the install record beside the run record and returns it as data", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);

    const data = envelope(setup.ctx)["data"] as Record<string, unknown>;
    const record = await readRecord(setup.pidgenHome);
    for (const key of [
      "form",
      "version",
      "artifact",
      "digest",
      "identity",
      "verified_at",
      "installed_at",
      "location",
    ]) {
      expect(record, key).toHaveProperty(key);
      expect(record[key], key).toEqual(data[key]);
    }
    expect(record).not.toHaveProperty("installed");
    // Beside the detached worker's run record, under the worker home.
    expect(join(setup.pidgenHome, "run", "pidgen-install.json")).toBe(
      join(setup.pidgenHome, "run", "pidgen-install.json"),
    );
  });

  it("is a no-op for the recorded version, and reinstalls it with --force", async () => {
    const setup = await installContext();
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    const first = await readRecord(setup.pidgenHome);
    const installsAfterFirst = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installsAfterFirst).toHaveLength(1);

    setup.ctx.out.length = 0;
    setup.ctx.err.length = 0;
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", installed: false, digest: DIGEST },
    });
    expect((await setup.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
    expect(await readRecord(setup.pidgenHome)).toEqual(first);

    setup.ctx.out.length = 0;
    expect(await runCli(["worker", "install", "--force"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { installed: true } });
    const installs = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installs).toHaveLength(2);
    expect(installs[1]!.args).toContain("--reinstall");
  });

  it("replaces the kept wheel of a superseded install", async () => {
    const setup = await installContext();
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    const record = await readRecord(setup.pidgenHome);
    const stale = join(setup.pidgenHome, "worker", "pidgen_worker-0.8.0-py3-none-any.whl");
    await writeFile(stale, "old");
    await writeFile(`${stale}.provenance.json`, "{}");
    await writeFile(
      join(setup.pidgenHome, "run", "pidgen-install.json"),
      JSON.stringify({ ...record, version: "0.8.0", file: stale }),
    );

    setup.ctx.out.length = 0;
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ data: { version: "1.0.0", installed: true } });
    expect((await listFiles(join(setup.pidgenHome, "worker"))).sort()).toEqual([
      WHEEL,
      `${WHEEL}.provenance.json`,
    ]);
    const installs = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installs[1]!.args).toContain("--reinstall");
  });

  // AC-6a86a3fa9119: RUNTIME_UNAVAILABLE (2) with install instructions when uv is missing.
  it("exits 2 with RUNTIME_UNAVAILABLE and the install instructions when uv is missing", async () => {
    const setup = await installContext({ uv: false });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Usage);
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({ ok: false, error: { code: "RUNTIME_UNAVAILABLE" } });
    const details = (env["error"] as { details: Record<string, unknown> }).details;
    expect(JSON.stringify(details["install"])).toContain("uv");
    expect(JSON.stringify(details["install"])).toContain("https://docs.astral.sh/uv/");
    expect(setup.spawns).toEqual([]);
  });

  it("exits 2 with RUNTIME_UNAVAILABLE for --runtime wheel when uv is missing", async () => {
    const setup = await installContext({ uv: false });

    expect(await runCli(["worker", "install", "--runtime", "wheel"], setup.ctx)).toBe(
      ExitCode.Usage,
    );
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
    expect(setup.spawns).toEqual([]);
  });

  // AC-6a86a3fa9119: RELEASE_UNSUPPORTED (5) for a version the server does not accept.
  it.each([
    ["0.7.0", "a series the server no longer accepts"],
    ["7.7.7", "a series the server does not list"],
  ])("exits 5 with RELEASE_UNSUPPORTED for %s (%s), before asking the index", async (version) => {
    const setup = await installContext();

    expect(await runCli(["worker", "install", "--version", version], setup.ctx)).toBe(
      ExitCode.Refused,
    );
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "RELEASE_UNSUPPORTED", details: { version, accepted: ["1.0", "0.9"] } },
    });
    expect(setup.fetchCalls.map((call) => call.url)).toEqual([RELEASES_URL]);
    expect(setup.spawns).toEqual([]);
  });

  it("installs the newest release of the server's current series, and no other series", async () => {
    const setup = await installContext({
      index: {
        "0.9.9": [indexWheel("0.9.9")],
        "1.0.0": [RECORDED_WHEEL],
        "1.0.0.dev7": [indexWheel("1.0.0.dev7")],
        "1.1.0": [indexWheel("1.1.0")],
      },
    });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { version: "1.0.0" } });
    expect(setup.fetchCalls.map((call) => call.url)).toContain(PYPI_JSON_URL);
  });

  it("exits 5 with RELEASE_UNSUPPORTED when the index has no release of the series", async () => {
    const setup = await installContext({ index: { "0.9.9": [indexWheel("0.9.9")] } });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      error: { code: "RELEASE_UNSUPPORTED", details: { series: "1.0", index: "pypi" } },
    });
    expect(setup.spawns).toEqual([]);
  });

  it("installs from TestPyPI with --test, where a development build of the series is a candidate", async () => {
    const setup = await installContext({ index: { "1.0.0": [RECORDED_WHEEL] } });

    expect(await runCli(["worker", "install", "--test"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", index: "testpypi" },
    });
    const urls = setup.fetchCalls.map((call) => call.url);
    expect(urls).toContain(TEST_PYPI_JSON_URL);
    expect(urls).toContain(TEST_PROVENANCE_URL);
    expect(urls).not.toContain(PYPI_JSON_URL);
  });

  it("installs the wheel with Python 3.12, the interpreter it was chosen for", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    const install = (await setup.uvRuns()).find((run) => run.args[1] === "install")!;
    expect(install.args.slice(0, 4)).toEqual(["tool", "install", "--python", "3.12"]);
  });

  it("reports a failing uv install and records nothing", async () => {
    const setup = await installContext({ uvFails: true });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "INSTALL_FAILED", details: { exit_code: 1 } },
    });
    expect(await listFiles(join(setup.pidgenHome, "run"))).not.toContain("pidgen-install.json");
  });

  it("passes on a server refusal of the release list", async () => {
    const setup = await installContext({
      releases: jsonResponse(503, {
        status: "error",
        error: { code: "SERVICE_UNAVAILABLE", message: "Try again later." },
      }),
    });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(setup.spawns).toEqual([]);
  });

  it("refuses a release list that does not match the contract", async () => {
    const setup = await installContext({
      releases: jsonResponse(200, { status: "ok", data: { current: "1.0.0", releases: "none" } }),
    });

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "UNEXPECTED_RESPONSE" },
    });
    expect(setup.spawns).toEqual([]);
  });

  it("reads the hosted server's release list when no server is configured", async () => {
    const setup = await installContext({ env: { PIDGEN_API_URL: "" } });
    delete setup.ctx.env["PIDGEN_API_URL"];

    // The fake answers only the test server, so the hosted one is unreachable here.
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Network);
    expect(setup.fetchCalls[0]?.url).toBe("https://api.pidgen.ai/api/v1/workers/releases");
  });

  it.each([
    [["worker", "install", "--runtime", "docker"], "an unknown runtime"],
    [["worker", "install", "--version"], "--version without a value"],
    [["worker", "install", "--version", " "], "an empty --version"],
    [["worker", "install", "extra"], "an unexpected argument"],
  ])("usage error: %j (%s)", async (argv) => {
    const setup = await installContext();

    expect(await runCli(argv, setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
    expect(setup.fetchCalls).toEqual([]);
    expect(setup.spawns).toEqual([]);
  });
});

describe("pidgen worker verify", () => {
  async function installed() {
    const setup = await installContext();
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    setup.ctx.out.length = 0;
    setup.ctx.err.length = 0;
    const record = await readRecord(setup.pidgenHome);
    return { setup, record };
  }

  // AC-606ba3384e4d: re-checks the installed file's digest and provenance, in doctor's shape.
  it("re-checks the installed file's digest and provenance and reports checks in doctor's shape", async () => {
    const { setup, record } = await installed();
    const callsBefore = setup.fetchCalls.length;

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.Ok);
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({ ok: true, data: { record } });
    const checks = (env["data"] as { checks: Array<Record<string, unknown>> }).checks;
    expect(checks.map((check) => check.id)).toEqual(["digest", "provenance"]);
    for (const check of checks) {
      expect(Object.keys(check).sort()).toEqual(["fix", "id", "status", "summary"]);
      expect(check).toMatchObject({ status: "ok", summary: expect.any(String), fix: null });
    }
    // No server is needed: the record and the kept attestation are local.
    expect(setup.fetchCalls.length).toBe(callsBefore);
    expect(setup.spawns.length).toBe(
      setup.spawns.filter((spawn) => spawn.args[0] === "tool").length,
    );
  });

  it("exits 4 with WORKER_NOT_INSTALLED when there is no install record", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_NOT_INSTALLED" },
    });
  });

  it("exits 5 with PROVENANCE_INVALID when the installed file no longer has the recorded digest", async () => {
    const { setup, record } = await installed();
    const kept = (await listFiles(setup.pidgenHome)).find((name) => name.endsWith(WHEEL))!;
    await writeFile(join(setup.pidgenHome, kept), "tampered");

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.Refused);
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { record } },
    });
    const checks = (env["error"] as { details: { checks: Array<Record<string, unknown>> } }).details
      .checks;
    expect(checks.find((check) => check.id === "digest")).toMatchObject({
      status: "fail",
      fix: "pidgen worker install --force",
    });
    const actual = createHash("sha256").update("tampered").digest("hex");
    expect(JSON.stringify(checks)).toContain(actual);
  });

  it("exits 5 with PROVENANCE_INVALID when the attestation no longer verifies against an accepted identity", async () => {
    const { setup } = await installed();
    setup.ctx.provenanceTrust = () => ({
      identities: [{ ...TEST_IDENTITY, subject: "https://github.com/example-org/other/*" }],
      trustedRoot: async () => fixture("trusted-root.json"),
    });

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.Refused);
    const env = envelope(setup.ctx);
    const checks = (env["error"] as { details: { checks: Array<Record<string, unknown>> } }).details
      .checks;
    expect(env).toMatchObject({ error: { code: "PROVENANCE_INVALID" } });
    expect(checks.find((check) => check.id === "digest")).toMatchObject({ status: "ok" });
    expect(checks.find((check) => check.id === "provenance")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("identity"),
      fix: "pidgen worker install --force",
    });
  });

  it("usage error for an unexpected argument", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "verify", "extra"], setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function reset(setup: InstallContext): void {
  setup.ctx.out.length = 0;
  setup.ctx.err.length = 0;
  setup.spawns.length = 0;
}

/** A detached worker started on the installed version with `--label alpha`. */
async function startDetached(setup: InstallContext): Promise<number> {
  expect(await runCli(["worker", "start", "--detach", "--", "--label", "alpha"], setup.ctx)).toBe(
    ExitCode.Ok,
  );
  reset(setup);
  return setup.workerStarts.at(-1)!.pid;
}

describe("pidgen worker update", () => {
  // AC-c3370be74b85: installs the current release with the same verification as install.
  it("installs the server's current release with the same verification as install and updates the record", async () => {
    const setup = await installContext();
    const previous = await previousInstall(setup);

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);

    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: {
        form: "wheel",
        version: "1.0.0",
        digest: DIGEST,
        identity: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
        updated: true,
        previous_version: "0.8.0",
        running: false,
        restarted: false,
      },
    });
    // Provenance was fetched and verified before uv ran on the verified file.
    expect(setup.fetchCalls.map((call) => call.url)).toContain(PROVENANCE_URL);
    const installs = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installs).toHaveLength(1);
    expect(installs[0]!.args).toContain("--reinstall");
    expect(installs[0]!.sha256).toBe(WHEEL_SHA256);
    expect(await readRecord(setup.pidgenHome)).toMatchObject({ version: "1.0.0", digest: DIGEST });
    // The superseded wheel is no longer kept.
    expect(await exists(previous["file"] as string)).toBe(false);
    expect(await readFile(setup.workerBin, "utf8")).toContain(WHEEL);
  });

  it("refuses a release whose attestation fails and keeps the previous install", async () => {
    const setup = await installContext({ provenance: fixture("provenance-wrong-identity.json") });
    const previous = await previousInstall(setup);

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { check: "identity" } },
    });
    expect((await setup.uvRuns()).filter((run) => run.args[1] === "install")).toEqual([]);
    expect(await readRecord(setup.pidgenHome)).toEqual(previous);
    expect(await exists(previous["file"] as string)).toBe(true);
  });

  it("installs the release named with --version", async () => {
    // 1.0.1 is the current series' newest release; --version picks the older 1.0.0.
    const setup = await installContext({ index: NEWER_PATCH_INDEX });
    await previousInstall(setup);

    expect(await runCli(["worker", "update", "--version", "1.0.0"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", updated: true, previous_version: "0.8.0" },
    });
  });

  it("is a no-op when the recorded version is already the release", async () => {
    const setup = await installContext();
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    reset(setup);

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", updated: false, previous_version: "1.0.0", restarted: false },
    });
    expect((await setup.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
  });

  // AC-c3370be74b85: a running detached worker restarts only with --restart.
  it("leaves a running detached worker on the old version without --restart", async () => {
    const setup = await installContext();
    await previousInstall(setup);
    const pid = await startDetached(setup);

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: { version: "1.0.0", updated: true, running: true, restarted: false },
    });
    expect(setup.signals).toEqual([]);
    expect(setup.workerStarts).toHaveLength(1);
    expect(setup.processes.has(pid)).toBe(true);
  });

  it("with --restart stops the detached worker after the install and starts it on the new version", async () => {
    const setup = await installContext();
    await previousInstall(setup);
    const pid = await startDetached(setup);

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Ok);
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({
      ok: true,
      data: { version: "1.0.0", updated: true, running: true, restarted: true },
    });
    expect(setup.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(setup.workerStarts.map((start) => [start.version, start.args, start.stayed])).toEqual([
      ["0.8.0", ["--label", "alpha"], true],
      ["1.0.0", ["--label", "alpha"], true],
    ]);
    expect((env["data"] as { worker: { pid: number } }).worker.pid).toBe(
      setup.workerStarts[1]!.pid,
    );
  });

  // AC-c3370be74b85: a restarted worker that exits during the startup check is rolled back.
  it("rolls back to the previous version and exits 1 with UPDATE_ROLLED_BACK when the restarted worker exits during startup", async () => {
    const setup = await installContext();
    const previous = await previousInstall(setup);
    await startDetached(setup);
    setup.crashing.add("1.0.0");

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: {
        code: "UPDATE_ROLLED_BACK",
        details: {
          version: "1.0.0",
          previous_version: "0.8.0",
          running: true,
          record: previous,
          log_tail: expect.any(Array),
        },
      },
    });
    // The previous version's kept wheel was reinstalled, and that version was restarted.
    const installs = (await setup.uvRuns()).filter((run) => run.args[1] === "install");
    expect(installs).toHaveLength(2);
    expect(installs[1]!.args).toEqual([
      "tool",
      "install",
      "--python",
      "3.12",
      "--reinstall",
      previous["file"],
    ]);
    expect(setup.workerStarts.map((start) => [start.version, start.stayed])).toEqual([
      ["0.8.0", true],
      ["1.0.0", false],
      ["0.8.0", true],
    ]);
    expect(setup.workerStarts[2]!.args).toEqual(["--label", "alpha"]);
    expect(setup.processes.has(setup.workerStarts[2]!.pid)).toBe(true);
    expect(await readRecord(setup.pidgenHome)).toEqual(previous);
    expect(await exists(previous["file"] as string)).toBe(true);
    expect((await listFiles(join(setup.pidgenHome, "worker"))).sort()).toEqual([
      PREVIOUS_WHEEL,
      `${PREVIOUS_WHEEL}.provenance.json`,
    ]);
  });

  it("refuses to roll back onto a kept wheel that no longer has its recorded digest", async () => {
    const setup = await installContext();
    const previous = await previousInstall(setup);
    await startDetached(setup);
    setup.crashing.add("1.0.0");
    await writeFile(previous["file"] as string, "tampered");

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "ROLLBACK_FAILED", details: { version: "1.0.0", previous_version: "0.8.0" } },
    });
    expect((await setup.uvRuns()).filter((run) => run.args[1] === "install")).toHaveLength(1);
  });

  it("exits 4 with WORKER_NOT_INSTALLED when there is no install record", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_NOT_INSTALLED" },
    });
    expect(setup.fetchCalls).toEqual([]);
    expect(setup.spawns).toEqual([]);
  });

  it("exits 5 with RELEASE_UNSUPPORTED for a --version the server does not accept", async () => {
    const setup = await installContext();
    const previous = await previousInstall(setup);

    expect(await runCli(["worker", "update", "--version", "0.7.0"], setup.ctx)).toBe(
      ExitCode.Refused,
    );
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "RELEASE_UNSUPPORTED" } });
    expect(await readRecord(setup.pidgenHome)).toEqual(previous);
    expect(setup.spawns).toEqual([]);
  });

  it("passes on a server refusal of the release list", async () => {
    const setup = await installContext({
      releases: jsonResponse(503, {
        status: "error",
        error: { code: "SERVICE_UNAVAILABLE", message: "Try again later." },
      }),
    });
    await previousInstall(setup);

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(setup.spawns).toEqual([]);
  });

  it.each([
    [["worker", "update", "--version"], "--version without a value"],
    [["worker", "update", "--version", " "], "an empty --version"],
    [["worker", "update", "extra"], "an unexpected argument"],
    [["worker", "update", "--force"], "an unknown flag"],
  ])("usage error: %j (%s)", async (argv) => {
    const setup = await installContext();
    await previousInstall(setup);

    expect(await runCli(argv, setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
    expect(setup.fetchCalls).toEqual([]);
    expect(setup.spawns).toEqual([]);
  });
});

describe("pidgen worker uninstall", () => {
  async function installed() {
    const setup = await installContext();
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    reset(setup);
    const record = await readRecord(setup.pidgenHome);
    // The worker's credential, which the worker stores in its home.
    const credential = join(setup.pidgenHome, "credential.json");
    await writeFile(credential, "{}\n");
    return { setup, record, credential };
  }

  // AC-ea6ee214c161: stops a detached worker, removes the tool and the record, keeps the home.
  it("stops a detached worker, removes the installed tool and the install record, and keeps the worker home", async () => {
    const { setup, record, credential } = await installed();
    const pid = await startDetached(setup);

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: true,
      data: {
        uninstalled: record,
        stopped: { record: { pid }, forced: false },
        removed: ["tool pidgen-worker", `file ${record["file"] as string}`],
        purged: false,
        worker_home: setup.pidgenHome,
      },
    });
    expect(setup.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    const uninstall = setup.spawns.find((spawn) => spawn.args[1] === "uninstall");
    expect(uninstall?.command).toBe(join(setup.pathDir, "uv"));
    expect(uninstall?.args).toEqual(["tool", "uninstall", "pidgen-worker"]);
    expect(uninstall?.stderrBefore).toContain("$ ");
    expect(await exists(setup.workerBin)).toBe(false);
    expect(await exists(join(setup.pidgenHome, "run", "pidgen-install.json"))).toBe(false);
    expect((await listFiles(setup.pidgenHome)).filter((name) => name.endsWith(".whl"))).toEqual([]);
    expect(await exists(credential)).toBe(true);
  });

  it("reports stopped: null when no detached worker is running", async () => {
    const { setup } = await installed();

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { stopped: null, purged: false } });
    expect(setup.signals).toEqual([]);
  });

  // AC-ea6ee214c161: --purge removes the worker home with its credential.
  it("removes the worker home, with the worker's credential, only with --purge", async () => {
    const { setup, credential } = await installed();
    await startDetached(setup);

    expect(await runCli(["worker", "uninstall", "--purge"], setup.ctx)).toBe(ExitCode.Ok);
    expect(envelope(setup.ctx)).toMatchObject({ ok: true, data: { purged: true } });
    expect(await exists(credential)).toBe(false);
    expect(await exists(setup.pidgenHome)).toBe(false);
  });

  it("refuses --purge when the worker home is the home directory, and removes nothing", async () => {
    const { setup, record } = await installed();
    setup.ctx.env["PIDGEN_HOME"] = setup.ctx.homeDir;
    const recordPath = join(setup.ctx.homeDir, "run", "pidgen-install.json");
    await mkdir(join(setup.ctx.homeDir, "run"), { recursive: true });
    await writeFile(recordPath, JSON.stringify(record));

    expect(await runCli(["worker", "uninstall", "--purge"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "PURGE_REFUSED" } });
    expect(setup.spawns).toEqual([]);
    expect(await exists(recordPath)).toBe(true);
    expect(await exists(setup.workerBin)).toBe(true);
  });

  // AC-ea6ee214c161: no install record exits 4 with WORKER_NOT_INSTALLED.
  it("exits 4 with WORKER_NOT_INSTALLED when there is no install record", async () => {
    const setup = await installContext();

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_NOT_INSTALLED" },
    });
    expect(setup.spawns).toEqual([]);
  });

  it("keeps the install record when uv cannot remove the tool", async () => {
    const setup = await installContext({ uvUninstallFails: true });
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    reset(setup);

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: { code: "UNINSTALL_FAILED", details: { exit_code: 2 } },
    });
    expect(await exists(join(setup.pidgenHome, "run", "pidgen-install.json"))).toBe(true);
  });

  it("finishes when the tool was already removed outside the CLI", async () => {
    const setup = await installContext({ uvUninstallFails: true });
    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    reset(setup);
    await rm(setup.workerBin);

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Ok);
    expect(await exists(join(setup.pidgenHome, "run", "pidgen-install.json"))).toBe(false);
  });

  it.each([
    [["worker", "uninstall", "extra"], "an unexpected argument"],
    [["worker", "uninstall", "--force"], "an unknown flag"],
  ])("usage error: %j (%s)", async (argv) => {
    const { setup } = await installed();

    expect(await runCli(argv, setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
    expect(setup.spawns).toEqual([]);
    expect(await exists(join(setup.pidgenHome, "run", "pidgen-install.json"))).toBe(true);
  });
});
