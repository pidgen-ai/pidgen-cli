import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePidgenHome, type WorkerConfig } from "./worker.js";

/**
 * This install's id: a random value kept in the worker home, `$PIDGEN_HOME/install-id` (by default
 * `~/.pidgen/install-id`), one line of 32 lowercase hex characters from 16 random bytes. It names
 * the install, not the machine: it is never derived from hardware, and a second worker home on the
 * same machine has its own. It is not a credential.
 *
 * `pidgen setup` and `pidgen worker enroll` create it when it is absent and send it as
 * `install_id` when they create an enrollment, so the server withdraws this install's earlier
 * pending enrollment and lists the worker it enrolls with the id. `pidgen-worker` keeps the same
 * file: whichever runs first creates it, and neither ever overwrites it. Moving `worker.env` aside
 * leaves it alone.
 */

/** The file's name in the worker home. */
export const INSTALL_ID_NAME = "install-id";

/** What the file holds: 32 lowercase hex characters (16 bytes). */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface InstallId {
  /** The id, or `null` when the file holds something else (`invalid`). */
  id: string | null;
  /** The file: `$PIDGEN_HOME/install-id`. */
  path: string;
  /** This call wrote the file. */
  created: boolean;
  /** The file exists but does not hold an install id; it is left as it is. */
  invalid: boolean;
}

export function installIdPath(config: Pick<WorkerConfig, "env" | "homeDir">): string {
  return join(resolvePidgenHome(config), INSTALL_ID_NAME);
}

/**
 * Reads this install's id, creating the file when it is absent. A file that holds anything but one
 * id (trailing white space aside) is left alone and answers `id: null`, `invalid: true`. The file
 * is created exclusively, so one written meanwhile, by `pidgen-worker` or another run, is read and
 * kept, never overwritten.
 */
export async function ensureInstallId(
  config: Pick<WorkerConfig, "env" | "homeDir">,
): Promise<InstallId> {
  const path = installIdPath(config);
  const existing = await readInstallId(path);
  if (existing !== null) return existing;
  const id = randomBytes(16).toString("hex");
  await mkdir(resolvePidgenHome(config), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${id}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Written since it was read: that one is this install's id.
    const written = await readInstallId(path);
    if (written !== null) return written;
    throw error;
  }
  return { id, path, created: true, invalid: false };
}

/**
 * This install's id when the worker home holds one, never creating the file: `null` when there is
 * none or it holds something else.
 */
export async function existingInstallId(
  config: Pick<WorkerConfig, "env" | "homeDir">,
): Promise<string | null> {
  return (await readInstallId(installIdPath(config)))?.id ?? null;
}

/** The id in `path`, `invalid` when it holds something else, or `null` when there is no file. */
async function readInstallId(path: string): Promise<InstallId | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Something the CLI cannot read as a file (a folder, say) is left alone like a wrong value.
    return { id: null, path, created: false, invalid: true };
  }
  const value = text.trim();
  return INSTALL_ID_PATTERN.test(value)
    ? { id: value, path, created: false, invalid: false }
    : { id: null, path, created: false, invalid: true };
}

/** The note an invalid file gets: it is left alone, and no id is sent. */
export function invalidInstallIdNote(path: string): string {
  return `${path} is not an install id (one line of 32 lowercase hex characters); it is left as it is, and no install id is sent.`;
}
