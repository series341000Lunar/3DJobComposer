import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const PRESET_CATEGORIES = ["jobDescription", "Referenceimage", "AIreferencePackage", "GenerateMasterReference"];
export const DEFAULT_PRESET_ROOT = fileURLToPath(new URL("../../PromptPreset/", import.meta.url));

export async function listPromptPresets(root = DEFAULT_PRESET_ROOT) {
  const categories = Object.fromEntries(PRESET_CATEGORIES.map((name) => [name, []]));
  const warnings = [];
  let folders;
  try { folders = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") warnings.push(`PromptPreset could not be read: ${error.message}`);
    return { categories, warnings };
  }
  for (const category of PRESET_CATEGORIES) {
    // Preserve existing Windows folder casing without renaming user files.
    const folder = folders.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === category.toLowerCase());
    if (!folder) continue;
    const directory = path.join(root, folder.name);
    try {
      const actualRoot = await realpath(root), actualDirectory = await realpath(directory);
      if (!actualDirectory.startsWith(actualRoot + path.sep)) throw new Error("Category is outside PromptPreset.");
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const file of files) {
        try { categories[category].push({ file: file.name, content: await readFile(path.join(directory, file.name), "utf8") }); }
        catch (error) { warnings.push(`${category}/${file.name}: ${error.message}`); }
      }
    } catch (error) { warnings.push(`${category}: ${error.message}`); }
  }
  return { categories, warnings };
}
