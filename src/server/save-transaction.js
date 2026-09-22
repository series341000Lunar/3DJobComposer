import { constants } from "node:fs";
import { mkdir, readFile, writeFile, copyFile, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const RECOVERY = ".composer-save-recovery";
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const validFile = (file) => /^(manifest\.json|TASK\.md|RUN_LOG\.md|references\/ref_[a-zA-Z0-9_-]+\.[a-z0-9]{1,10})$/.test(file);
async function present(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function recoveryStatus(jobPath) {
  const recoveryPath = path.join(jobPath, RECOVERY);
  if (!(await present(recoveryPath))) return null;
  return { state: "recovery_required", recoveryPath,
    message: `Save/recovery is pending at ${recoveryPath}. Saving is disabled. Stop Composer and run the documented recovery command before editing.` };
}
async function cleanup(directory) {
  // directory is always the fixed recovery child of the exact supplied Job.
  if (path.basename(directory) !== RECOVERY) throw new Error("Invalid recovery directory.");
  // Remove the journal first: cleanup interruption must never roll back a committed save.
  await rm(path.join(directory, "journal.json"), { force: true });
  await rm(directory, { recursive: true, force: true });
}
async function validateJournal(journal) {
  if (journal.version !== 1 || !Array.isArray(journal.entries)) throw new Error("Invalid recovery journal.");
  const seen = new Set();
  for (const entry of journal.entries) {
    if (!validFile(entry.file) || seen.has(entry.file)) throw new Error("Unsafe recovery entry.");
    seen.add(entry.file);
    if (entry.before !== null && (typeof entry.before !== "string" ||
        digest(Buffer.from(entry.before, "base64")) !== entry.beforeHash)) throw new Error("Recovery backup checksum mismatch.");
  }
}
async function rollback(jobPath, journal) {
  await validateJournal(journal);
  for (const entry of [...journal.entries].reverse()) {
    const target = path.join(jobPath, entry.file);
    if (entry.before === null) {
      await rm(target, { force: true });
      if (await present(target)) throw new Error(`Rollback did not remove ${entry.file}`);
    } else {
      const bytes = Buffer.from(entry.before, "base64");
      // Skip intact files, including RUN_LOG (which is never backed up).
      if (!(await readFile(target).catch(() => Buffer.alloc(0))).equals(bytes)) await writeFile(target, bytes);
      if (digest(await readFile(target)) !== entry.beforeHash) throw new Error(`Rollback verification failed: ${entry.file}`);
    }
  }
  if (!journal.hadReferences) await rmdir(path.join(jobPath, "references")).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
// Manual recovery is intentionally separate from LOAD. Run only with Composer stopped.
export async function recoverSave(jobPath) {
  jobPath = path.resolve(jobPath);
  const directory = path.join(jobPath, RECOVERY);
  if (!(await present(directory))) return { state: "nothing_to_recover" };
  const journalPath = path.join(directory, "journal.json");
  if (!(await present(journalPath))) {
    // No final writes started, or verified commit/rollback already removed its journal.
    // Cleanup does not change the current Job contents.
    await cleanup(directory);
    return { state: "cleanup_completed" };
  }
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  await validateJournal(journal);
  if (await present(path.join(directory, "COMMITTED"))) {
    for (const entry of journal.entries) {
      if (digest(await readFile(path.join(jobPath, entry.file))) !== entry.afterHash) {
        throw new Error("Committed contents changed; retain recovery data for manual inspection.");
      }
    }
    await cleanup(directory);
    return { state: "committed" };
  }
  await rollback(jobPath, journal);
  await cleanup(directory);
  return { state: "rolled_back" };
}
export async function commitSave(jobPath, entries) {
  const directory = path.join(jobPath, RECOVERY);
  try { await mkdir(directory); } catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error((await recoveryStatus(jobPath)).message), { statusCode: 409 });
    throw error;
  }
  let journal;
  let published = false;
  let committed = false;
  try {
    journal = { version: 1, hadReferences: await present(path.join(jobPath, "references")), entries: [] };
    for (const [index, entry] of entries.entries()) {
      if (!validFile(entry.file)) throw new Error("Invalid transaction target.");
      const target = path.join(jobPath, entry.file);
      let before = null;
      try { before = await readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if ((entry.file === "RUN_LOG.md" || entry.file.startsWith("references/")) && before !== null) throw new Error(`${entry.file} appeared during save; retry after reload.`);
      await writeFile(path.join(directory, `staged-${index}`), entry.bytes, { flag: "wx" });
      if (!(await readFile(path.join(directory, `staged-${index}`))).equals(entry.bytes)) throw new Error("Staging verification failed.");
      if (entry.file === "manifest.json") JSON.parse(entry.bytes.toString("utf8"));
      journal.entries.push({ file: entry.file, before: before?.toString("base64") ?? null,
        beforeHash: before === null ? null : digest(before), afterHash: digest(entry.bytes) });
    }
    await writeFile(path.join(directory, "journal.pending"), JSON.stringify(journal), { flag: "wx" });
    if (await readFile(path.join(directory, "journal.pending"), "utf8") !== JSON.stringify(journal)) throw new Error("Recovery journal verification failed.");
    await rename(path.join(directory, "journal.pending"), path.join(directory, "journal.json"));
    published = true;
    await mkdir(path.join(jobPath, "references"), { recursive: true });
    for (const [index, entry] of journal.entries.entries()) {
      await copyFile(path.join(directory, `staged-${index}`), path.join(jobPath, entry.file),
        entry.before === null ? constants.COPYFILE_EXCL : 0);
      if (digest(await readFile(path.join(jobPath, entry.file))) !== entry.afterHash) throw new Error(`Commit verification failed: ${entry.file}`);
    }
    await writeFile(path.join(directory, "COMMITTED"), "All transaction files verified.\n", { flag: "wx" });
    committed = true;
  } catch (error) {
    try {
      if (published) await rollback(jobPath, journal);
      await cleanup(directory);
    } catch (rollbackError) {
      const recovery = { state: "recovery_required", recoveryPath: directory };
      throw Object.assign(new Error(`SAVE FAILED; recovery required at ${directory}. ${error.message}; recovery: ${rollbackError.message}`), { statusCode: 500, recovery });
    }
    throw Object.assign(new Error(`SAVE FAILED; previous state restored and verified. ${error.message}`),
      { statusCode: 500, recovery: { state: "rolled_back" } });
  }
  if (committed) {
    try { await cleanup(directory); } catch {
      return { state: "committed_cleanup_required", recoveryPath: directory };
    }
  }
  return { state: "committed" };
}
