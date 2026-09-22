const state = {
  config: null,
  presets: {}, destinations: [], saving: false,
  descriptionPreset: null, descriptionSource: "", loadedIdentity: null,
  workflowInstructions: {},
  readOnly: false,
  references: [],
  aiItems: [],
  mode: "new",
  editToken: null,
  loadedJobPath: null,
  openToken: null
};
const byId = (id) => document.getElementById(id);


function exactText(field, original = "") {
  return typeof original === "string" && field.value === original.replace(/\r\n?/g, "\n") ? original : field.value;
}
function populatePresets(select, category) {
  const current = select.value;
  const presets = state.presets[category] || [];
  select.replaceChildren(new Option(presets.length ? "Select a preset" : "No presets available", ""));
  presets.forEach((preset) => select.add(new Option(preset.file, preset.file)));
  if (presets.some((preset) => preset.file === current)) select.value = current;
}

const workflowFields = [
  { key: "generate_master_reference", prefix: "master", category: "GenerateMasterReference" },
  { key: "ai_reference_package", prefix: "package-instruction", category: "AIreferencePackage" }
];
function updateWorkflow() {
  const generate = byId("workflow-generate").checked;
  byId("master-workflow-fields").hidden = !generate;
  byId("reference-heading").textContent = generate ? "Source reference images (optional)" : "Reference images";
  byId("reference-help").textContent = generate
    ? "Attach zero or more sources. All attached images are included in the request; no Master Reference exists yet."
    : "Add images in the exact order they should be reviewed.";
}
function updateWorkflowPresetNotices() {
  for (const { key, prefix, category } of workflowFields) {
    const saved = state.workflowInstructions[key];
    const current = (state.presets[category] || []).find((item) => item.file === saved?.preset_file);
    byId(prefix + "-preset-status").textContent = !saved?.preset_file ? "Manual instruction; no applied preset." :
      !current ? `Saved preset: ${saved.preset_file}. Source preset unavailable; saved snapshot and instruction retained.` :
      current.content !== saved.preset_snapshot ? `Saved preset: ${saved.preset_file}. Source has changed; saved snapshot and instruction retained.` :
      `Applied preset: ${saved.preset_file}. Edits below change only the effective instruction.`;
  }
}
function restoreWorkflow(workflow = { mode: "direct" }) {
  state.workflowInstructions = {};
  byId("workflow-direct").checked = workflow.mode === "direct";
  byId("workflow-generate").checked = workflow.mode === "generate_master_reference";
  for (const { key, prefix, category } of workflowFields) {
    const saved = workflow[key] || { preset_file: null, preset_snapshot: null, effective_instruction: "" };
    state.workflowInstructions[key] = { ...saved };
    byId(prefix + "-instruction").value = saved.effective_instruction || "";
    populatePresets(byId(prefix + "-preset"), category);
    byId(prefix + "-preset").value = (state.presets[category] || []).some((item) => item.file === saved.preset_file) ? saved.preset_file : "";
  }
  updateWorkflow();
  updateWorkflowPresetNotices();
}
function serializeWorkflow() {
  if (byId("workflow-direct").checked) return { mode: "direct" };
  const workflow = { mode: "generate_master_reference" };
  for (const { key, prefix } of workflowFields) {
    const saved = state.workflowInstructions[key] || {};
    workflow[key] = {
      preset_file: saved.preset_file || null,
      preset_snapshot: saved.preset_snapshot ?? null,
      effective_instruction: exactText(byId(prefix + "-instruction"), saved.effective_instruction || "")
    };
  }
  return workflow;
}

async function refreshPresets() {
  try {
    const response = await fetch("/api/presets");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.presets = result.categories;
    workflowFields.forEach(({ prefix, category }) => populatePresets(byId(prefix + "-preset"), category));
    updateWorkflowPresetNotices();
    populatePresets(byId("description-preset"), "jobDescription");
    byId("reference-list").querySelectorAll(".reference-preset").forEach((select) => populatePresets(select, "Referenceimage"));
    byId("preset-status").textContent = result.warnings.join("\n");
  } catch (error) { byId("preset-status").textContent = "Presets unavailable. Manual input remains available. " + error.message; }
}
function applyTextPreset(select, category, field, message, applied) {
  if (state.readOnly || state.saving) return;
  const preset = (state.presets[category] || []).find((item) => item.file === select.value);
  if (!preset) return;
  if (field.value !== "" && !confirm(message)) return;
  field.value = preset.content;
  applied({ file: preset.file, resolved_content: preset.content });
}
function renderDestinations(selected = "") {
  const select = byId("destination-preset");
  select.replaceChildren(new Option(state.destinations.length ? "Select a destination" : "No presets available", ""));
  state.destinations.forEach((preset) => select.add(new Option(preset.name, preset.name)));
  select.value = selected;
}
async function loadDestinations() {
  try {
    const response = await fetch("/api/settings"), result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.destinations = result.destinationPresets;
    renderDestinations(state.destinations.find((preset) => preset.path === byId("root-path").value)?.name || "");
  } catch (error) { byId("destination-status").textContent = error.message; }
}
async function changeDestination(action) {
  if (state.saving) return;
  const select = byId("destination-preset");
  const name = action === "save" ? prompt("Destination preset name", select.value) : select.value;
  if (!name?.trim()) return;
  if (action === "delete" && !confirm("Delete this destination preset?")) return;
  try {
    const response = await fetch("/api/settings/destinations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, name, path: byId("root-path").value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.destinations = result.destinationPresets;
    renderDestinations(action === "save" ? name.trim() : "");
    byId("destination-status").textContent = action === "save" ? "Destination preset saved on this machine." : "Destination preset deleted.";
  } catch (error) { byId("destination-status").textContent = error.message; }
}

function addOptions(select, values, defaultValue) {
  select.replaceChildren();
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = option.textContent = value;
    option.selected = value === defaultValue;
    select.append(option);
  });
}

function choice(name, value, checked = false) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const span = document.createElement("span");
  span.textContent = value;
  label.append(input, span);
  return label;
}

function addChoices(container, name, values, defaults = []) {
  container.replaceChildren();
  values.forEach((value) => container.append(choice(name, value, defaults.includes(value))));
}

function checkedValues(container) {
  return [...container.querySelectorAll("input:checked")].map((input) => input.value);
}

function setCheckedValues(container, values) {
  container.querySelectorAll("input").forEach((input) => { input.checked = values.includes(input.value); });
}

function formatBytes(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function referenceNumber(internalId) {
  const index = state.references.findIndex((reference) => reference.id === internalId);
  return index < 0 ? null : `REF-${String(index + 1).padStart(3, "0")}`;
}

function updateReferenceOrder() {
  [...byId("reference-list").children].forEach((card, index) => {
    card.querySelector(".reference-index").textContent = `REF-${String(index + 1).padStart(3, "0")}`;
  });
  renderAiItems();
}

function renderReference(reference) {
  const card = byId("reference-template").content.firstElementChild.cloneNode(true);
  card.dataset.id = reference.id;
  const preview = card.querySelector(".reference-preview");
  if (reference.missing) {
    card.classList.add("is-missing");
    preview.remove();
    const missing = document.createElement("div");
    missing.className = "missing-reference";
    missing.textContent = `Missing file\n${reference.existingFile || reference.originalName}`;
    card.querySelector(".reference-preview-wrap").append(missing);
  } else if (reference.file) {
    const objectUrl = URL.createObjectURL(reference.file);
    preview.src = objectUrl;
    preview.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
  } else if (reference.dataBase64) {
    preview.src = `data:${reference.mimeType};base64,${reference.dataBase64}`;
  }
  preview.alt = `Preview of ${reference.originalName}`;
  card.querySelector(".reference-name").textContent = reference.originalName;
  const estimatedSize = reference.file?.size ?? Math.floor((reference.dataBase64?.length || 0) * 0.75);
  card.querySelector(".reference-meta").textContent = `${reference.missing ? "MISSING · " : ""}${formatBytes(estimatedSize)} · ${reference.mimeType || "image"}`;
  addChoices(card.querySelector(".reference-roles"), `roles-${reference.id}`, state.config.options.referenceRoles, reference.roles || []);
  card.querySelector(".reference-note").value = reference.note || "";
  populatePresets(card.querySelector(".reference-preset"), "Referenceimage");
  card.querySelector(".apply-reference-preset").addEventListener("click", () =>
    applyTextPreset(card.querySelector(".reference-preset"), "Referenceimage", card.querySelector(".reference-note"),
      "현재 Reference Note를 프리셋 내용으로 교체하시겠습니까?", (snapshot) => {
        reference.notePreset = snapshot;
        reference.note = snapshot.resolved_content;
      }));
  card.querySelector(".remove-button").addEventListener("click", () => {
    state.references = state.references.filter((item) => item.id !== reference.id);
    state.aiItems.forEach((item) => { item.sourceReferenceIds = item.sourceReferenceIds.filter((id) => id !== reference.id); });
    card.remove();
    updateReferenceOrder();
  });
  byId("reference-list").append(card);
}

function addFiles(fileList) {
  [...fileList].filter((file) => file.type.startsWith("image/")).forEach((file) => {
    const reference = {
      id: crypto.randomUUID(), file, originalName: file.name, mimeType: file.type || "application/octet-stream",
      dataBase64: null, existingFile: null, missing: false, roles: [], note: ""
    };
    state.references.push(reference);
    renderReference(reference);
  });
  updateReferenceOrder();
}

function sanitizedPreview(value) {
  let result = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^[. _]+|[. _]+$/g, "").slice(0, 100).replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result)) result = `_${result}`;
  return result;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function serializeReferences() {
  return Promise.all(state.references.map(async (reference) => {
    const card = byId("reference-list").querySelector(`[data-id="${CSS.escape(reference.id)}"]`);
    return {
      originalName: reference.originalName,
      mimeType: reference.mimeType,
      dataBase64: reference.file ? await fileToBase64(reference.file) : null,
      existingFile: reference.existingFile,
      missing: reference.missing,
      roles: checkedValues(card.querySelector(".reference-roles")),
      note: exactText(card.querySelector(".reference-note"), reference.note),
      notePreset: reference.notePreset || null
    };
  }));
}

function addAiItem(initial = {}) {
  state.aiItems.push({
    id: crypto.randomUUID(),
    enabled: initial.enabled !== false,
    mode: initial.mode || "Three-View + Isometric",
    scope: initial.scope || "Whole Asset",
    sourceReferenceIds: initial.sourceReferenceIds || [],
    targetPart: initial.targetPart || "",
    note: initial.note || ""
  });
  renderAiItems();
}

function renderAiItems() {
  const list = byId("ai-item-list");
  if (!list || !state.config) return;
  list.replaceChildren();
  state.aiItems.forEach((item, index) => {
    const card = byId("ai-item-template").content.firstElementChild.cloneNode(true);
    card.dataset.id = item.id;
    card.querySelector(".ai-item-index").textContent = `RP-${String(index + 1).padStart(3, "0")}`;
    const enabled = card.querySelector(".ai-item-enabled");
    enabled.checked = item.enabled;
    enabled.addEventListener("change", () => { item.enabled = enabled.checked; });
    const mode = card.querySelector(".ai-mode");
    addOptions(mode, state.config.options.referencePackageModes, item.mode);
    mode.value = item.mode;
    mode.addEventListener("change", () => { item.mode = mode.value; });
    const scope = card.querySelector(".ai-scope");
    addOptions(scope, state.config.options.referencePackageScopes, item.scope);
    scope.value = item.scope;
    const targetWrap = card.querySelector(".ai-target-part-wrap");
    const target = card.querySelector(".ai-target-part");
    target.value = item.targetPart;
    const updateScope = () => { item.scope = scope.value; targetWrap.hidden = scope.value !== "Specific Part"; };
    updateScope();
    scope.addEventListener("change", updateScope);
    target.addEventListener("input", () => { item.targetPart = target.value; });
    const sources = card.querySelector(".ai-source-references");
    state.references.forEach((reference) => {
      const refId = referenceNumber(reference.id);
      const option = choice(`sources-${item.id}`, reference.id, item.sourceReferenceIds.includes(reference.id));
      option.querySelector("span").textContent = `${refId} · ${reference.originalName}`;
      option.querySelector("input").addEventListener("change", () => { item.sourceReferenceIds = checkedValues(sources); });
      sources.append(option);
    });
    if (!state.references.length) sources.textContent = "Add a Source Reference image first.";
    const note = card.querySelector(".ai-note");
    note.value = item.note;
    note.addEventListener("input", () => { item.note = note.value; });
    card.querySelector(".ai-remove").addEventListener("click", () => { state.aiItems = state.aiItems.filter((entry) => entry.id !== item.id); renderAiItems(); });
    list.append(card);
  });
}

function serializeReferencePackage() {
  return {
    enabled: byId("ai-package-enabled").checked,
    items: state.aiItems.map((item) => ({
      enabled: item.enabled,
      mode: item.mode,
      scope: item.scope,
      sourceReferences: item.sourceReferenceIds.map(referenceNumber).filter(Boolean),
      targetPart: item.scope === "Specific Part" ? item.targetPart : null,
      note: item.note
    }))
  };
}

function showStatus(type, message, openToken = null) {
  const status = byId("status");
  status.hidden = false;
  status.className = `status ${type}`;
  status.replaceChildren(document.createTextNode(message));
  if (openToken) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "open-button";
    button.textContent = "OPEN JOB FOLDER";
    button.addEventListener("click", async () => {
      const response = await fetch("/api/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: openToken }) });
      if (!response.ok) showStatus("error", (await response.json()).error);
    });
    status.append(document.createElement("br"), button);
  }
}

function setMode(mode, result = null) {
  state.mode = mode;
  state.readOnly = result?.readOnly === true;
  byId("create-button").disabled = state.readOnly;
  const editing = mode === "editing";
  byId("mode-badge").textContent = state.readOnly ? "READ ONLY" : editing ? "EDITING" : "NEW JOB";
  byId("mode-badge").classList.toggle("editing", editing);
  byId("mode-title").textContent = state.readOnly ? "Current Mode: Read-only Job" : editing ? "Current Mode: Editing Existing Job" : "Current Mode: New Job";
  byId("loaded-job-label").textContent = editing ? `Loaded Job: ${state.loadedJobPath}` : "Create a new package without overwriting an existing Job.";
  byId("new-job-button").hidden = !editing;
  byId("job-name").readOnly = state.readOnly;
  byId("root-path").readOnly = state.readOnly;
  byId("save-as-button").hidden = !editing;
  byId("save-as-button").disabled = state.readOnly;
  byId("create-button").textContent = editing ? "SAVE CHANGES" : "CREATE JOB";
  byId("create-section-title").textContent = editing ? "Save loaded package" : "Create package";
  byId("create-section-help").textContent = state.readOnly ? "Inspection only. Saving is disabled to protect this Job." : editing ? "SAVE CHANGES updates the loaded folder above. Changed Job Name / Job Root apply only to SAVE AS." : "Choose an absolute Windows folder path.";
  if (result?.warnings?.length) {
    byId("load-warnings").hidden = false;
    byId("load-warnings").textContent = `Warnings:\n- ${result.warnings.join("\n- ")}`;
  } else {
    byId("load-warnings").hidden = true;
  }
}

function applyLoadedJob(result) {
  const job = result.job;
  state.loadedIdentity = { jobName: job.jobName, rootPath: job.rootPath };
  state.descriptionPreset = job.descriptionPreset || null;
  state.descriptionSource = job.description;
  restoreWorkflow(job.referenceWorkflow);
  state.editToken = result.editToken;
  state.loadedJobPath = result.jobPath;
  state.openToken = result.openToken;
  byId("job-name").value = job.jobName;
  byId("sanitized-name").textContent = `Folder: ${sanitizedPreview(job.jobName)}`;
  byId("description").value = job.description;
  byId("root-path").value = job.rootPath;
  renderDestinations(state.destinations.find((preset) => preset.path === job.rootPath)?.name || "");
  byId("load-job-path").value = result.jobPath;
  byId("asset-category").value = job.asset.category;
  byId("quality").value = job.asset.quality;
  byId("purpose").value = job.target.purpose;
  byId("dcc").value = job.target.dcc;
  byId("unit").value = job.target.unit;
  setCheckedValues(byId("motion-options"), job.asset.motion);
  setCheckedValues(byId("subject-options"), job.asset.subject);
  setCheckedValues(byId("work-scope-options"), job.workScope);
  setCheckedValues(byId("output-options"), job.deliverables);

  state.references = job.references.map((reference) => ({ ...reference, id: crypto.randomUUID(), file: null }));
  byId("reference-list").replaceChildren();
  state.references.forEach(renderReference);
  state.aiItems = job.referencePackage.items.map((item) => ({
    id: crypto.randomUUID(), enabled: item.enabled, mode: item.mode, scope: item.scope,
    sourceReferenceIds: item.sourceReferences.map((sourceId) => {
      const index = Number(sourceId.slice(4)) - 1;
      return state.references[index]?.id;
    }).filter(Boolean),
    targetPart: item.targetPart || "", note: item.note || ""
  }));
  byId("ai-package-enabled").checked = job.referencePackage.enabled;
  byId("ai-package-details").hidden = !job.referencePackage.enabled;
  updateReferenceOrder();
  setMode("editing", result);
  showStatus("success", `Job loaded.\n\n${result.jobPath}`, result.openToken);
}

async function loadExistingJob() {
  const jobPath = byId("load-job-path").value.trim();
  if (!jobPath) return showStatus("error", "Enter an existing Job folder path.");
  const button = byId("load-job-button");
  button.disabled = true;
  button.textContent = "LOADING…";
  try {
    const response = await fetch("/api/jobs/load", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobPath }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load the Job.");
    applyLoadedJob(result);
  } catch (error) {
    showStatus("error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "LOAD JOB";
  }
}

function resetToNewJob() {
  restoreWorkflow();
  state.editToken = null;
  state.loadedJobPath = null;
  state.loadedIdentity = null;
  state.descriptionPreset = null;
  state.descriptionSource = "";
  state.references = [];
  state.aiItems = [];
  byId("reference-list").replaceChildren();
  byId("job-name").value = "";
  byId("description").value = "";
  byId("sanitized-name").textContent = "Folder name will appear here.";
  byId("asset-category").value = "Unspecified";
  byId("quality").value = "Unspecified";
  byId("purpose").value = "Unspecified";
  byId("dcc").value = "Unspecified";
  byId("unit").value = "Unspecified";
  setCheckedValues(byId("motion-options"), []);
  setCheckedValues(byId("subject-options"), []);
  setCheckedValues(byId("work-scope-options"), ["Unspecified"]);
  setCheckedValues(byId("output-options"), []);
  byId("ai-package-enabled").checked = false;
  byId("ai-package-details").hidden = true;
  byId("status").hidden = true;
  setMode("new");
}

async function buildPayload() {
  return {
    jobName: byId("job-name").value,
    description: exactText(byId("description"), state.descriptionSource),
    descriptionPreset: state.descriptionPreset,
    rootPath: byId("root-path").value.trim(),
    asset: {
      category: byId("asset-category").value,
      quality: byId("quality").value,
      motion: checkedValues(byId("motion-options")),
      subject: checkedValues(byId("subject-options"))
    },
    target: { purpose: byId("purpose").value, dcc: byId("dcc").value, unit: byId("unit").value },
    workScope: checkedValues(byId("work-scope-options")),
    deliverables: checkedValues(byId("output-options")),
    references: await serializeReferences(),
    referencePackage: serializeReferencePackage(),
    referenceWorkflow: serializeWorkflow()
  };
}


async function submit(event, action = "default") {
  event.preventDefault();
  if (state.saving) return;
  if (state.readOnly) return showStatus("error", "This Job is read-only. Saving is disabled.");
  const saveAs = action === "saveAs";
  const editing = state.mode === "editing";
  // Cancellation precedes serialization, status changes, localStorage and HTTP.
  if (saveAs ? !confirm("새로 저장하시겠습니까?") : editing && !confirm("덮어쓰시겠습니까?")) return;
  if (saveAs && !editing) return;
  const button = byId("create-button");
  if ((saveAs || !editing) && !sanitizedPreview(byId("job-name").value)) return showStatus("error", "Job Name must contain at least one safe character.");
  const invalidPart = state.aiItems.find((item) => item.scope === "Specific Part" && !item.targetPart.trim());
  if (invalidPart) return showStatus("error", "Target Part Name is required for every Specific Part package item.");
  state.saving = true;
  button.disabled = true;
  byId("job-form").inert = true;
  byId("load-job-button").disabled = true;
  byId("new-job-button").disabled = true;
  button.textContent = "SAVING…";
  showStatus("success", saveAs ? "Creating a new Job from the current authoring state…" : editing ? "Saving the loaded Job…" : "Creating the package…");
  try {
    const payload = await buildPayload();
    // Editable name/root are Save As destinations; SAVE CHANGES remains bound to its source.
    if (editing && !saveAs) Object.assign(payload, state.loadedIdentity);
    const response = await fetch(saveAs ? "/api/jobs/save-as" : editing ? "/api/jobs/save" : "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? { editToken: state.editToken, job: payload } : payload)
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.recovery?.state === "recovery_required") setMode(state.mode, { readOnly: true, warnings: [result.error] });
      throw new Error(result.error || "Could not save the Job.");
    }
    localStorage.setItem("3dJobComposer.rootPath", payload.rootPath);
    if (saveAs) {
      if (result.loadError) {
        showStatus("error", `New Job created at ${result.jobPath}, but it could not be loaded: ${result.loadError}. Load that path before editing it. The original Job remains active.`);
        return;
      }
      applyLoadedJob(result);
    } else if (editing) {
      state.references.forEach((reference, index) => {
        reference.existingFile = result.references[index].existingFile;
        reference.file = null;
      });
    }
    state.openToken = result.openToken;
    if (result.recovery?.state === "committed_cleanup_required") {
      state.readOnly = true;
      showStatus("error", `Saved successfully, but recovery cleanup is required: ${result.recovery.recoveryPath}. Stop Composer and run the documented recovery command.`);
      return;
    }
    showStatus("success", `Job ${saveAs || !editing ? "created" : "saved"} successfully.\n\n${result.jobPath}`, result.openToken);
  } catch (error) { showStatus("error", error.message); }
  finally {
    state.saving = false;
    byId("job-form").inert = false;
    byId("load-job-button").disabled = false;
    byId("new-job-button").disabled = false;
    button.disabled = state.readOnly;
    byId("save-as-button").disabled = state.readOnly;
    button.textContent = state.mode === "editing" ? "SAVE CHANGES" : "CREATE JOB";
  }
}

async function initialize() {
  const response = await fetch("/api/config");
  state.config = await response.json();
  const options = state.config.options;
  const runtimeName = state.config.runtime?.executable?.split(/[\\/]/).pop() || "node";
  byId("version").textContent = `v${state.config.composerVersion} · schema ${state.config.schemaVersion} · ${runtimeName} PID ${state.config.runtime?.pid ?? "?"}`;
  addOptions(byId("asset-category"), options.assetCategories, "Unspecified");
  addOptions(byId("quality"), options.qualityLevels, "Unspecified");
  addOptions(byId("purpose"), options.purposes, "Unspecified");
  addOptions(byId("dcc"), options.dccs, "Unspecified");
  addOptions(byId("unit"), options.units, "Unspecified");
  addChoices(byId("motion-options"), "motion", options.motionTypes, []);
  addChoices(byId("subject-options"), "subject", options.subjectTypes, []);
  addChoices(byId("work-scope-options"), "workScope", options.workScopes, ["Unspecified"]);
  addChoices(byId("output-options"), "deliverables", options.outputs, []);
  byId("root-path").value = localStorage.getItem("3dJobComposer.rootPath") || "C:\\_InternalProjects\\3DJobs";

  const dropZone = byId("drop-zone");
  const fileInput = byId("reference-input");
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove("is-dragging"); }));
  dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  byId("job-name").addEventListener("input", (event) => { byId("sanitized-name").textContent = sanitizedPreview(event.target.value) ? `Folder: ${sanitizedPreview(event.target.value)}` : "Folder name will appear here."; });
  byId("ai-package-enabled").addEventListener("change", (event) => { byId("ai-package-details").hidden = !event.target.checked; });
  byId("add-ai-item").addEventListener("click", () => addAiItem());
  byId("load-job-button").addEventListener("click", loadExistingJob);
  byId("new-job-button").addEventListener("click", resetToNewJob);
  byId("job-form").addEventListener("submit", submit);
  byId("save-as-button").addEventListener("click", (event) => submit(event, "saveAs"));
  byId("refresh-presets").addEventListener("click", refreshPresets);
  byId("apply-description-preset").addEventListener("click", () =>
    applyTextPreset(byId("description-preset"), "jobDescription", byId("description"),
      "현재 Job Description을 프리셋 내용으로 교체하시겠습니까?", (snapshot) => {
        state.descriptionPreset = snapshot;
        state.descriptionSource = snapshot.resolved_content;
      }));
  byId("destination-preset").addEventListener("change", () => {
    const preset = state.destinations.find((item) => item.name === byId("destination-preset").value);
    if (preset && !state.readOnly && !state.saving) byId("root-path").value = preset.path;
  });
  byId("save-destination").addEventListener("click", () => changeDestination("save"));
  byId("delete-destination").addEventListener("click", () => changeDestination("delete"));
  byId("root-path").addEventListener("input", () => renderDestinations(state.destinations.find((preset) => preset.path === byId("root-path").value)?.name || ""));
  for (const { key, prefix, category } of workflowFields) {
    byId("apply-" + prefix + "-preset").addEventListener("click", () =>
      applyTextPreset(byId(prefix + "-preset"), category, byId(prefix + "-instruction"),
        "현재 지시문을 프리셋 내용으로 교체하시겠습니까?", (snapshot) => {
          state.workflowInstructions[key] = {
            preset_file: snapshot.file, preset_snapshot: snapshot.resolved_content,
            effective_instruction: snapshot.resolved_content
          };
          updateWorkflowPresetNotices();
        }));
  }
  byId("workflow-direct").addEventListener("change", updateWorkflow);
  byId("workflow-generate").addEventListener("change", updateWorkflow);
  restoreWorkflow();
  setMode("new");
  await Promise.all([refreshPresets(), loadDestinations()]);
}

initialize().catch((error) => showStatus("error", `Could not initialize the app: ${error.message}`));
