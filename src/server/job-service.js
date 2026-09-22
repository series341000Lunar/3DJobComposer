import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { OPTIONS } from "./constants.js";
import { buildManifest, normalizeJobInput, ValidationError } from "./job-schema.js";
import { renderTask } from "./task-renderer.js";

const RUN_LOG_TEMPLATE_URL = new URL("../../templates/RUN_LOG.template.md", import.meta.url);

export class JobExistsError extends Error {
  constructor(jobPath) {
    super(`A job already exists at: ${jobPath}`);
    this.name = "JobExistsError";
    this.jobPath = jobPath;
  }
}

export class JobLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobLoadError";
  }
}

async function exists(filePath) {
  try { await access(filePath, fsConstants.F_OK); return true; } catch { return false; }
}

function assertAbsolutePath(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || !path.isAbsolute(trimmed)) throw new ValidationError(`${label} must be an absolute path.`, label);
  return path.resolve(trimmed);
}

function referenceExtension(originalName) {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin";
}

function mimeFromFilename(filename) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff" })[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function decodeReference(dataBase64) {
  if (typeof dataBase64 !== "string") throw new ValidationError("New reference data is missing.", "references");
  const payload = dataBase64.includes(",") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
  const normalized = payload.replace(/\s/g, "");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) throw new ValidationError("Reference data is not valid base64.", "references");
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new ValidationError("Reference file is empty.", "references");
  return buffer;
}

function resolveExistingReference(jobPath, relativeFile) {
  if (typeof relativeFile !== "string" || path.isAbsolute(relativeFile)) throw new ValidationError("Existing reference path must be relative.", "references");
  const normalized = relativeFile.replace(/\\/g, "/");
  const referenceRoot = path.resolve(jobPath, "references");
  const resolved = path.resolve(jobPath, normalized);
  if (resolved !== referenceRoot && !resolved.startsWith(`${referenceRoot}${path.sep}`)) throw new ValidationError("Existing reference path must remain inside references/.", "references");
  return { resolved, relativePath: path.relative(jobPath, resolved).split(path.sep).join("/") };
}

async function nextReferenceFilename(referenceDirectory, originalName) {
  const extension = referenceExtension(originalName);
  const entries = new Set(await readdir(referenceDirectory).catch(() => []));
  for (let number = 1; number <= 9_999; number += 1) {
    const filename = `ref_${String(number).padStart(3, "0")}${extension}`;
    if (!entries.has(filename)) return filename;
  }
  return `ref_${crypto.randomUUID()}${extension}`;
}

function storedReference(reference, relativePath) {
  return { originalName: reference.originalName, mimeType: reference.mimeType, roles: reference.roles, note: reference.note, relativePath };
}

async function ensureRunLog(jobPath) {
  const runLogPath = path.join(jobPath, "RUN_LOG.md");
  if (await exists(runLogPath)) return false;
  const template = await readFile(RUN_LOG_TEMPLATE_URL, "utf8");
  try {
    await writeFile(runLogPath, template, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function createJob(rawInput) {
  const job = normalizeJobInput(rawInput);
  const rootPath = assertAbsolutePath(job.rootPath, "Job Root");
  await mkdir(rootPath, { recursive: true });
  const finalPath = path.join(rootPath, job.name);
  if (await exists(finalPath)) throw new JobExistsError(finalPath);
  const temporaryPath = path.join(rootPath, `.${job.name}.creating-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);

  try {
    await mkdir(temporaryPath, { recursive: false });
    await Promise.all([mkdir(path.join(temporaryPath, "references")), mkdir(path.join(temporaryPath, "work")), mkdir(path.join(temporaryPath, "output"))]);
    const storedReferences = [];
    for (let index = 0; index < job.references.length; index += 1) {
      const reference = job.references[index];
      if (reference.existingFile) throw new ValidationError("New Jobs cannot use an existing reference path.", "references");
      const filename = `ref_${String(index + 1).padStart(3, "0")}${referenceExtension(reference.originalName)}`;
      const relativePath = `references/${filename}`;
      await writeFile(path.join(temporaryPath, "references", filename), decodeReference(reference.dataBase64), { flag: "wx" });
      storedReferences.push(storedReference(reference, relativePath));
    }
    const manifest = buildManifest(job, storedReferences);
    const task = renderTask(job, storedReferences);
    const runLogTemplate = await readFile(RUN_LOG_TEMPLATE_URL, "utf8");
    await Promise.all([
      writeFile(path.join(temporaryPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(temporaryPath, "TASK.md"), task, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(temporaryPath, "RUN_LOG.md"), runLogTemplate, { encoding: "utf8", flag: "wx" })
    ]);
    if (await exists(finalPath)) throw new JobExistsError(finalPath);
    await rename(temporaryPath, finalPath);
    return { jobPath: finalPath, jobName: job.name, manifest };
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function allowedValue(value, allowed, fallback, warnings, label) {
  if (allowed.includes(value)) return value;
  if (value != null) warnings.push(`${label} value “${value}” is not supported by this Composer version; using ${fallback}.`);
  return fallback;
}

function allowedList(value, allowed, fallback, warnings, label) {
  if (!Array.isArray(value)) return fallback;
  const result = [...new Set(value.filter((item) => allowed.includes(item)))];
  if (result.length !== value.length) warnings.push(`${label} contained unsupported values that were not restored.`);
  return result.length ? result : fallback;
}

export async function loadJob(jobPathInput) {
  const jobPath = assertAbsolutePath(jobPathInput, "Job path");
  const manifestPath = path.join(jobPath, "manifest.json");
  if (!(await exists(manifestPath))) throw new JobLoadError(`manifest.json was not found in: ${jobPath}`);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { throw new JobLoadError(`manifest.json could not be read: ${error.message}`); }

  const warnings = [];
  if (!(await exists(path.join(jobPath, "TASK.md")))) warnings.push("TASK.md is missing. It will be regenerated when the Job is saved.");
  if (!(await exists(path.join(jobPath, "references")))) warnings.push("references/ is missing. It will be recreated when the Job is saved.");
  if (!(await exists(path.join(jobPath, "RUN_LOG.md")))) warnings.push("RUN_LOG.md is missing. An empty template will be added when the Job is saved.");
  if (!["1.0", "1.1"].includes(String(manifest.schema_version))) warnings.push(`Schema ${manifest.schema_version ?? "unknown"} is not explicitly supported; compatible fields were restored where possible.`);

  const manifestReferences = Array.isArray(manifest.references) ? manifest.references : [];
  const idMap = new Map();
  const references = [];
  for (let index = 0; index < manifestReferences.length; index += 1) {
    const source = manifestReferences[index] || {};
    const newId = `REF-${String(index + 1).padStart(3, "0")}`;
    idMap.set(source.id || newId, newId);
    const relativeFile = typeof source.file === "string" ? source.file : `references/missing_${index + 1}.bin`;
    let resolvedInfo;
    try { resolvedInfo = resolveExistingReference(jobPath, relativeFile); } catch {
      warnings.push(`${source.id || newId} has an unsafe file path and was marked missing.`);
      resolvedInfo = { resolved: path.join(jobPath, "references", `missing_${index + 1}.bin`), relativePath: `references/missing_${index + 1}.bin` };
    }
    let dataBase64 = null;
    let missing = false;
    try { dataBase64 = (await readFile(resolvedInfo.resolved)).toString("base64"); } catch {
      missing = true;
      warnings.push(`${source.id || newId} file is missing: ${relativeFile}`);
    }
    references.push({
      id: newId,
      originalName: source.original_name || path.basename(relativeFile),
      mimeType: source.media_type || mimeFromFilename(relativeFile),
      dataBase64,
      existingFile: resolvedInfo.relativePath,
      missing,
      roles: allowedList(source.roles, OPTIONS.referenceRoles, [], warnings, `${source.id || newId} roles`),
      note: typeof source.note === "string" ? source.note : ""
    });
  }

  const packageSource = manifest.reference_package && typeof manifest.reference_package === "object" ? manifest.reference_package : { enabled: false, items: [] };
  const packageItems = [];
  for (const [index, item] of (Array.isArray(packageSource.items) ? packageSource.items : []).entries()) {
    if (!OPTIONS.referencePackageModes.includes(item?.mode) || !OPTIONS.referencePackageScopes.includes(item?.scope)) {
      warnings.push(`AI Reference Package item ${item?.id || index + 1} uses an unsupported mode or scope and was not restored.`);
      continue;
    }
    packageItems.push({
      enabled: item.enabled !== false,
      mode: item.mode,
      scope: item.scope,
      sourceReferences: (Array.isArray(item.source_references) ? item.source_references : []).map((id) => idMap.get(id)).filter(Boolean),
      targetPart: typeof item.target_part === "string" ? item.target_part : "",
      note: typeof item.note === "string" ? item.note : ""
    });
  }

  const legacyOutputs = manifest.target?.outputs;
  return {
    jobPath,
    warnings,
    job: {
      jobName: manifest.job?.name || path.basename(jobPath),
      description: typeof manifest.job?.description === "string" ? manifest.job.description : "",
      rootPath: path.dirname(jobPath),
      asset: {
        category: allowedValue(manifest.asset?.category, OPTIONS.assetCategories, "Unspecified", warnings, "Asset category"),
        quality: allowedValue(manifest.asset?.quality, OPTIONS.qualityLevels, "Unspecified", warnings, "Quality"),
        motion: allowedList(manifest.asset?.motion, OPTIONS.motionTypes, [], warnings, "Motion"),
        subject: allowedList(manifest.asset?.subject, OPTIONS.subjectTypes, [], warnings, "Subject")
      },
      target: {
        purpose: allowedValue(manifest.target?.purpose, OPTIONS.purposes, "Unspecified", warnings, "Purpose"),
        dcc: allowedValue(manifest.target?.dcc, OPTIONS.dccs, "Unspecified", warnings, "DCC"),
        unit: allowedValue(manifest.target?.unit, OPTIONS.units, "Unspecified", warnings, "Unit")
      },
      workScope: allowedList(manifest.work_scope, OPTIONS.workScopes, ["Unspecified"], warnings, "Work Scope"),
      deliverables: allowedList(manifest.deliverables ?? legacyOutputs, OPTIONS.outputs, [], warnings, "Deliverables"),
      references,
      referencePackage: { enabled: packageSource.enabled === true, items: packageItems }
    }
  };
}

export async function saveJob(jobPathInput, rawInput) {
  const jobPath = assertAbsolutePath(jobPathInput, "Loaded Job path");
  if (!(await exists(path.join(jobPath, "manifest.json")))) throw new JobLoadError("The loaded Job no longer contains manifest.json.");
  const job = normalizeJobInput(rawInput);
  if (job.name.toLowerCase() !== path.basename(jobPath).toLowerCase()) throw new ValidationError("A loaded Job cannot be renamed during SAVE JOB.", "jobName");

  const referenceDirectory = path.join(jobPath, "references");
  await mkdir(referenceDirectory, { recursive: true });
  const storedReferences = [];
  for (const reference of job.references) {
    if (reference.existingFile) {
      const resolved = resolveExistingReference(jobPath, reference.existingFile);
      if (!(await exists(resolved.resolved)) && !reference.missing) throw new ValidationError(`Existing reference is missing: ${resolved.relativePath}`, "references");
      storedReferences.push(storedReference(reference, resolved.relativePath));
    } else {
      const filename = await nextReferenceFilename(referenceDirectory, reference.originalName);
      const relativePath = `references/${filename}`;
      await writeFile(path.join(referenceDirectory, filename), decodeReference(reference.dataBase64), { flag: "wx" });
      storedReferences.push(storedReference(reference, relativePath));
    }
  }

  const manifest = buildManifest(job, storedReferences);
  const task = renderTask(job, storedReferences);
  const nonce = crypto.randomBytes(6).toString("hex");
  const manifestTemp = path.join(jobPath, `.manifest.${nonce}.tmp`);
  const taskTemp = path.join(jobPath, `.TASK.${nonce}.tmp`);
  try {
    await Promise.all([writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"), writeFile(taskTemp, task, "utf8")]);
    await Promise.all([copyFile(manifestTemp, path.join(jobPath, "manifest.json")), copyFile(taskTemp, path.join(jobPath, "TASK.md"))]);
  } finally {
    await Promise.all([rm(manifestTemp, { force: true }), rm(taskTemp, { force: true })]);
  }
  await ensureRunLog(jobPath);
  return { jobPath, jobName: job.name, manifest };
}
