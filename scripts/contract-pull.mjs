// Fetches the App Service's public API document into contracts/openapi.json, refusing a document
// that cites internal records (see scripts/contract-check.mjs).
// Usage: npm run contract:pull -- --url https://pidgen.example.com
import { pullContract } from "./contract-check.mjs";

const index = process.argv.indexOf("--url");
const base = index === -1 ? process.env.PIDGEN_API_URL : process.argv[index + 1];
if (!base) {
  console.error("usage: npm run contract:pull -- --url <server>   (or set PIDGEN_API_URL)");
  process.exit(2);
}

process.exit(await pullContract({ base }));
