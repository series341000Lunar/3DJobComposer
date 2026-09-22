import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ValidationError } from "./job-schema.js";
export const DEFAULT_SETTINGS_PATH = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".config"),
  "3DJobComposer", "settings.local.json");
const queues = new Map();
export async function readSettings(file = DEFAULT_SETTINGS_PATH) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        (value.destinationPresets !== undefined && (!Array.isArray(value.destinationPresets) ||
        value.destinationPresets.some((item) => !item || typeof item.name !== "string" || typeof item.path !== "string")))) {
      throw new Error("Invalid destination presets.");
    }
    return { ...value, destinationPresets: value.destinationPresets || [] };
  } catch (error) {
    if (error.code === "ENOENT") return { destinationPresets: [] };
    throw new Error(`Local settings could not be read; existing file was preserved: ${error.message}`);
  }
}
export async function updateDestinationPreset(input, file = DEFAULT_SETTINGS_PATH) {
  const previous = queues.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 255) throw new ValidationError("Preset name is required (maximum 255 characters).");
    if (!["save", "delete"].includes(input.action)) throw new ValidationError("Invalid preset action.");
    const current = await readSettings(file);
    if (input.action === "save") {
      const destination = typeof input.path === "string" ? input.path.trim() : "";
      if (!destination || !path.isAbsolute(destination)) throw new ValidationError("Destination must be an absolute path.");
      const existing = current.destinationPresets.find((item) => item.name === name);
      if (existing) existing.path = destination;
      else current.destinationPresets.push({ name, path: destination });
    } else current.destinationPresets = current.destinationPresets.filter((item) => item.name !== name);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(current, null, 2) + "\n", { flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return current;
  });
  queues.set(file, operation);
  try { return await operation; } finally { if (queues.get(file) === operation) queues.delete(file); }
}
