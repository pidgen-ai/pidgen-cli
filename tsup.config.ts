import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { pidgen: "src/bin/pidgen.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  clean: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  define: { __PIDGEN_VERSION__: JSON.stringify(version) },
});
