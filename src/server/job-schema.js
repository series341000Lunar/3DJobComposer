import { COMPOSER_VERSION, OPTIONS, SCHEMA_VERSION } from "./constants.js";

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export function sanitizeJobName(value) {
  const original = String(value ?? "").normalize("NFKC");
  let result = original
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[. _]+|[. _]+$/g, "")
    .slice(0, 100)
    .replace(/[. ]+$/g, "");

  if (WINDOWS_RESERVED_NAMES.test(result)) result = `_${result}`;
  if (!result) throw new ValidationError("Job Name must contain at least one safe character.", "jobName");
  return result;
}

function requireOption(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid value for ${field}.`, field);
  }
  return value;
}

function requireOptionList(value, allowed, field, { min = 0 } = {}) {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list.`, field);
  const unique = [...new Set(value)];
  if (unique.length < min || unique.some((item) => !allowed.includes(item))) {
    throw new ValidationError(`Invalid value for ${field}.`, field);
  }
  return unique;
}

function requireText(value, field, { allowEmpty = false, max = 100_000 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new ValidationError(`${field} is required.`, field);
  }
  if (value.length > max) throw new ValidationError(`${field} is too long.`, field);
  return value;
}

function validatePreset(value) {
  if (value == null) return null;
  if (typeof value !== "object" || typeof value.file !== "string" ||
      /[\\/]/.test(value.file) || !/\.(md|txt)$/i.test(value.file)) throw new ValidationError("Invalid preset identity.");
  return {
    file: requireText(value.file, "preset.file", { max: 255 }),
    resolved_content: requireText(value.resolved_content, "preset.resolved_content", { allowEmpty: true })
  };
}

function validateReference(reference, index) {
  if (!reference || typeof reference !== "object") {
    throw new ValidationError(`Reference ${index + 1} is invalid.`, "references");
  }

  return {
    originalName: requireText(reference.originalName, `references[${index}].originalName`, { max: 255 }),
    mimeType: typeof reference.mimeType === "string" ? reference.mimeType : "application/octet-stream",
    dataBase64: reference.dataBase64 == null
      ? null
      : requireText(reference.dataBase64, `references[${index}].dataBase64`, { max: 140_000_000 }),
    existingFile: reference.existingFile == null
      ? null
      : requireText(reference.existingFile, `references[${index}].existingFile`, { max: 1_024 }),
    missing: reference.missing === true,
    notePreset: validatePreset(reference.notePreset),
    roles: requireOptionList(reference.roles, OPTIONS.referenceRoles, `references[${index}].roles`),
    note: requireText(reference.note ?? "", `references[${index}].note`, { allowEmpty: true })
  };
}

function validateReferencePackage(value, referenceCount) {
  if (value == null) return { enabled: false, items: [] };
  if (typeof value !== "object") throw new ValidationError("referencePackage is invalid.", "referencePackage");
  const items = Array.isArray(value.items) ? value.items : [];
  if (items.length > 50) throw new ValidationError("A maximum of 50 AI Reference Package items is supported.", "referencePackage.items");

  return {
    enabled: value.enabled === true,
    items: items.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new ValidationError(`AI Reference Package item ${index + 1} is invalid.`, "referencePackage.items");
      }
      const scope = requireOption(item.scope, OPTIONS.referencePackageScopes, `referencePackage.items[${index}].scope`);
      const sourceReferences = [...new Set(Array.isArray(item.sourceReferences) ? item.sourceReferences : [])];
      if (sourceReferences.some((id) => !/^REF-\d{3}$/.test(id) || Number(id.slice(4)) < 1 || Number(id.slice(4)) > referenceCount)) {
        throw new ValidationError(`Invalid source reference in AI item ${index + 1}.`, `referencePackage.items[${index}].sourceReferences`);
      }
      const targetPart = requireText(item.targetPart ?? "", `referencePackage.items[${index}].targetPart`, { allowEmpty: true, max: 255 });
      if (scope === "Specific Part" && !targetPart.trim()) {
        throw new ValidationError(`Target Part is required for AI item ${index + 1}.`, `referencePackage.items[${index}].targetPart`);
      }
      return {
        enabled: item.enabled !== false,
        mode: requireOption(item.mode, OPTIONS.referencePackageModes, `referencePackage.items[${index}].mode`),
        scope,
        sourceReferences,
        targetPart: scope === "Specific Part" ? targetPart : null,
        note: requireText(item.note ?? "", `referencePackage.items[${index}].note`, { allowEmpty: true })
      };
    })
  };
}


function normalizeWorkflowInstruction(value, required) {
  if (value == null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Workflow instruction must be an object.", "referenceWorkflow");
  const snapshot = value.preset_file == null ? null : validatePreset({
    file: value.preset_file, resolved_content: value.preset_snapshot
  });
  if (!snapshot && value.preset_snapshot != null) throw new ValidationError("A preset snapshot needs its filename.", "referenceWorkflow");
  return {
    preset_file: snapshot?.file ?? null,
    preset_snapshot: snapshot?.resolved_content ?? null,
    effective_instruction: requireText(value.effective_instruction ?? "", "Master / package effective instruction", { allowEmpty: !required })
  };
}

export function normalizeReferenceWorkflow(value, referenceCount, { allowIncomplete = false } = {}) {
  if (value == null) value = { mode: "direct" };
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Reference Workflow must be an object.", "referenceWorkflow");
  const mode = requireOption(value.mode ?? "direct", ["direct", "generate_master_reference"], "referenceWorkflow.mode");
  // Inactive generation drafts stay in the UI session, not in the active contract.
  if (mode === "direct") return { mode };
  return {
    mode,
    source_reference_ids: Array.from({ length: referenceCount }, (_, index) => `REF-${String(index + 1).padStart(3, "0")}`),
    generate_master_reference: normalizeWorkflowInstruction(value.generate_master_reference, !allowIncomplete),
    ai_reference_package: normalizeWorkflowInstruction(value.ai_reference_package, false),
    requested_output_root: "work/AIReferencePackage"
  };
}

export function normalizeJobInput(input, { allowIncompleteWorkflow = false } = {}) {
  if (!input || typeof input !== "object") throw new ValidationError("Request body is invalid.");
  const originalName = requireText(input.jobName, "jobName", { max: 255 });
  const name = sanitizeJobName(originalName);
  const references = Array.isArray(input.references) ? input.references.map(validateReference) : [];
  if (references.length > 50) throw new ValidationError("A maximum of 50 references is supported.", "references");

  return {
    rootPath: requireText(input.rootPath, "rootPath", { max: 1_024 }).trim(),
    name,
    originalName,
    description: requireText(input.description, "description"),
    descriptionPreset: validatePreset(input.descriptionPreset),
    asset: {
      category: requireOption(input.asset?.category, OPTIONS.assetCategories, "asset.category"),
      quality: requireOption(input.asset?.quality, OPTIONS.qualityLevels, "asset.quality"),
      motion: requireOptionList(input.asset?.motion ?? [], OPTIONS.motionTypes, "asset.motion"),
      subject: requireOptionList(input.asset?.subject ?? [], OPTIONS.subjectTypes, "asset.subject")
    },
    target: {
      purpose: requireOption(input.target?.purpose, OPTIONS.purposes, "target.purpose"),
      dcc: requireOption(input.target?.dcc, OPTIONS.dccs, "target.dcc"),
      unit: requireOption(input.target?.unit, OPTIONS.units, "target.unit"),
    },
    workScope: requireOptionList(input.workScope ?? ["Unspecified"], OPTIONS.workScopes, "workScope"),
    deliverables: requireOptionList(
      input.deliverables ?? input.target?.outputs ?? [],
      OPTIONS.outputs,
      "deliverables"
    ),
    referenceWorkflow: normalizeReferenceWorkflow(input.referenceWorkflow, references.length, { allowIncomplete: allowIncompleteWorkflow }),
    referencePackage: validateReferencePackage(input.referencePackage, references.length),
    references
  };
}

export function buildManifest(job, storedReferences) {
  const jobSection = {
    name: job.name,
    description: job.description
  };
  if (job.originalName !== job.name) jobSection.original_name = job.originalName;

  return {
    schema_version: SCHEMA_VERSION,
    composer_version: COMPOSER_VERSION,
    job: jobSection,
    asset: job.asset,
    target: job.target,
    work_scope: job.workScope,
    deliverables: job.deliverables,
    reference_workflow: job.referenceWorkflow,
    references: storedReferences.map((reference, index) => ({
      id: `REF-${String(index + 1).padStart(3, "0")}`,
      file: reference.relativePath,
      original_name: reference.originalName,
      media_type: reference.mimeType,
      roles: reference.roles,
      note: reference.note
    })),
    reference_package: {
      enabled: job.referencePackage.enabled,
      items: job.referencePackage.items.map((item, index) => ({
        id: `RP-${String(index + 1).padStart(3, "0")}`,
        enabled: item.enabled,
        mode: item.mode,
        scope: item.scope,
        source_references: item.sourceReferences,
        target_part: item.targetPart,
        note: item.note
      }))
    },
    metadata: {
      reference_file_policy: "Removed references are excluded from manifest and TASK.md; existing files are retained on disk.",
      ...(job.descriptionPreset ? { job_description_preset: job.descriptionPreset } : {}),
      ...(storedReferences.some((ref) => ref.notePreset) ? {
        reference_note_presets: Object.fromEntries(storedReferences.filter((ref) => ref.notePreset)
          .map((ref) => [ref.relativePath, ref.notePreset]))
      } : {})
    }
  };
}
