// Refuses a release while any skill is still imported (not yet ported to pidgen commands).
// Imported skills contain private material and must never be published. See CONTRIBUTING.md, "Skills".
import { readFile } from "node:fs/promises";

const imported = JSON.parse(await readFile("tests/skills/imported.json", "utf8"));
if (imported.length > 0) {
  console.error(`Release blocked: ${imported.length} skill(s) are still imported:`);
  for (const name of imported) console.error(`  - ${name}`);
  console.error("Port or remove them first (CONTRIBUTING.md, Skills).");
  process.exit(1);
}
console.log("Release check passed: no imported skills.");
