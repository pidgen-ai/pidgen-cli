import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  DEFAULT_SERVER_URL,
  loadConfig,
  resolveTarget,
  saveConfig,
} from "../../src/core/config.js";
import { testContext } from "../support/context.js";

const config = {
  default_profile: "default",
  profiles: {
    default: {
      url: "https://pidgen.example.com",
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "cli" as const, token: "pidgen_cli_example" } },
    },
  },
};

describe("config file", () => {
  it("is empty when missing", async () => {
    const ctx = await testContext();
    expect(await loadConfig(ctx)).toEqual({ default_profile: "default", profiles: {} });
  });

  it("round-trips and is written owner-only", async () => {
    const ctx = await testContext();
    await saveConfig(ctx, config);
    expect(await loadConfig(ctx)).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(configPath(ctx))).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === "win32")("refuses a file others can read", async () => {
    const ctx = await testContext();
    const path = configPath(ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config));
    await chmod(path, 0o644);
    await expect(loadConfig(ctx)).rejects.toMatchObject({ code: "CONFIG_PERMISSIONS" });
  });

  it("honours XDG_CONFIG_HOME", async () => {
    const ctx = await testContext();
    ctx.env["XDG_CONFIG_HOME"] = "/xdg";
    expect(configPath(ctx)).toBe("/xdg/pidgen/config.json");
  });
});

describe("resolveTarget", () => {
  it("uses the profile's default Account and its credential", async () => {
    const ctx = await testContext();
    expect(resolveTarget(ctx, config, {})).toEqual({
      profile: "default",
      url: "https://pidgen.example.com",
      token: "pidgen_cli_example",
      account: "ACC-EXAMPLE",
    });
  });

  it("lets the environment override the profile", async () => {
    const ctx = await testContext({
      env: { PIDGEN_API_URL: "https://other.example.com", PIDGEN_TOKEN: "pidgen_pat_example" },
    });
    expect(resolveTarget(ctx, config, {})).toMatchObject({
      url: "https://other.example.com",
      token: "pidgen_pat_example",
    });
  });

  it("has no credential for an Account it has not logged in to", async () => {
    const ctx = await testContext();
    expect(resolveTarget(ctx, config, { account: "ACC-OTHER" }).token).toBeNull();
  });

  it("uses the hosted server when neither PIDGEN_API_URL nor the profile names one", async () => {
    const ctx = await testContext();
    const empty = { default_profile: "default", profiles: {} };
    expect(resolveTarget(ctx, empty, {}).url).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe("https://api.pidgen.ai");
  });
});
