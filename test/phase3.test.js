import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, loadJob, saveJob, saveJobAs } from "../src/server/job-service.js";
let root;
before(async () => {
  const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await fs.mkdir(temp, { recursive: true });
  root = await fs.mkdtemp(path.join(temp, "phase3-"));
});
const input = (name, workflow) => ({ jobName: name, rootPath: root, description: "Literal job",
  asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
  target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" },
  workScope: [], deliverables: [], references: [], referenceWorkflow: workflow });
const instruction = (text = "# 한국어\r\nGenerate a reference.\n") => ({
  preset_file: "Original.md", preset_snapshot: text, effective_instruction: text
});
const workflow = () => ({ mode: "generate_master_reference",
  generate_master_reference: instruction(), ai_reference_package: instruction("Use for modeling\r\n") });
const ref = (index) => ({ originalName: "image" + index + ".png", mimeType: "image/png",
  dataBase64: Buffer.from([index, 1, 255]).toString("base64"), roles: index === 1 ? ["Shape"] : ["Material"],
  note: "note " + index, notePreset: { file: "Note.md", resolved_content: "Note source" } });
const manifest = async (jobPath) => JSON.parse(await fs.readFile(path.join(jobPath, "manifest.json"), "utf8"));
async function snapshot(dir) {
  const entries = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    entries[e.name] = e.isDirectory() ? await snapshot(path.join(dir, e.name)) : (await fs.readFile(path.join(dir, e.name))).toString("base64");
  }
  return entries;
}
test("P3 direct defaults and ignores incomplete inactive generation fields", async () => {
  const a = await createJob(input("direct", { mode: "direct", generate_master_reference: "invalid draft" }));
  assert.deepEqual(a.manifest.reference_workflow, { mode: "direct" });
  assert.match(await fs.readFile(path.join(a.jobPath, "TASK.md"), "utf8"), /Direct Reference/);
  assert.deepEqual((await loadJob(a.jobPath)).job.referenceWorkflow, { mode: "direct" });
});
test("P3 image-free generation stores literal snapshots, instructions, and a request only", async () => {
  const a = await createJob(input("zero", workflow()));
  assert.equal(a.manifest.schema_version, "1.2");
  assert.equal(a.manifest.composer_version, "0.3.0");
  assert.deepEqual(a.manifest.reference_workflow.source_reference_ids, []);
  assert.deepEqual(a.manifest.references, []);
  assert.deepEqual(await fs.readdir(path.join(a.jobPath, "references")), []);
  assert.deepEqual(await fs.readdir(path.join(a.jobPath, "work")), []);
  const task = await fs.readFile(path.join(a.jobPath, "TASK.md"), "utf8");
  assert.ok(task.includes(workflow().generate_master_reference.effective_instruction));
  assert.ok(task.includes(workflow().ai_reference_package.effective_instruction));
  assert.match(task, /work\/AIReferencePackage/);
  assert.match(task, /does not call GPT Image/);
  assert.deepEqual((await loadJob(a.jobPath)).job.referenceWorkflow, a.manifest.reference_workflow);
});
test("P3 manual generation needs no presets or package instruction", async () => {
  const a = await createJob(input("manual", { mode: "generate_master_reference",
    generate_master_reference: { effective_instruction: "Manual only" } }));
  assert.deepEqual(a.manifest.reference_workflow.generate_master_reference,
    { preset_file: null, preset_snapshot: null, effective_instruction: "Manual only" });
  assert.equal(a.manifest.reference_workflow.ai_reference_package.effective_instruction, "");
});
test("P3 required master instruction and malformed provenance fail without files", async () => {
  for (const [i, w] of [
    { mode: "generate_master_reference" },
    { ...workflow(), generate_master_reference: instruction("  ") },
    { ...workflow(), generate_master_reference: { ...instruction(), preset_file: "../outside.md" } },
    { ...workflow(), ai_reference_package: { preset_snapshot: "orphan" } },
    { mode: "unknown" }
  ].entries()) {
    await assert.rejects(createJob(input("invalid" + i, w)));
    await assert.rejects(fs.access(path.join(root, "invalid" + i)));
  }
});
test("P3 multi-reference SAVE preserves runtime output, sources, snapshots and unknown fields", async () => {
  const a = await createJob({ ...input("multi", workflow()), references: [ref(1), ref(2)] });
  a.manifest.reference_workflow.extra = { preserve: true };
  await fs.writeFile(path.join(a.jobPath, "manifest.json"), JSON.stringify(a.manifest));
  await fs.mkdir(path.join(a.jobPath, "work", "AIReferencePackage"));
  await fs.writeFile(path.join(a.jobPath, "work", "AIReferencePackage", "master.png"), "existing agent output");
  await fs.writeFile(path.join(a.jobPath, "RUN_LOG.md"), "production log");
  await fs.writeFile(path.join(a.jobPath, "output", "asset.glb"), "output");
  const before = await snapshot(a.jobPath);
  const loaded = await loadJob(a.jobPath);
  await saveJob(a.jobPath, loaded.job);
  assert.deepEqual(await manifest(a.jobPath), a.manifest);
  loaded.job.referenceWorkflow.generate_master_reference.effective_instruction = "Edited final instruction";
  await saveJob(a.jobPath, loaded.job);
  const saved = await manifest(a.jobPath), after = await snapshot(a.jobPath);
  assert.deepEqual(saved.reference_workflow.source_reference_ids, ["REF-001", "REF-002"]);
  assert.equal(saved.reference_workflow.generate_master_reference.preset_snapshot, instruction().preset_snapshot);
  assert.equal(saved.reference_workflow.generate_master_reference.effective_instruction, "Edited final instruction");
  assert.deepEqual(saved.reference_workflow.extra, { preserve: true });
  for (const key of ["references", "work", "output", "RUN_LOG.md"]) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(saved.references.map((r) => r.roles), [["Shape"], ["Material"]]);
});
test("P3 SAVE AS copies workflow and independent sources but no runtime artifacts", async () => {
  const a = await createJob({ ...input("clone-source", workflow()), references: [ref(1), ref(2)] });
  await fs.writeFile(path.join(a.jobPath, "work", "master.png"), "generated");
  await fs.writeFile(path.join(a.jobPath, "output", "model.blend"), "model");
  await fs.writeFile(path.join(a.jobPath, "RUN_LOG.md"), "existing run");
  const before = await snapshot(a.jobPath);
  const b = await saveJobAs(a.jobPath, { ...(await loadJob(a.jobPath)).job, jobName: "clone-new" });
  assert.deepEqual(b.manifest.reference_workflow, a.manifest.reference_workflow);
  assert.deepEqual(await snapshot(a.jobPath), before);
  assert.deepEqual(await snapshot(path.join(b.jobPath, "references")), before.references);
  assert.deepEqual(await fs.readdir(path.join(b.jobPath, "work")), []);
  assert.deepEqual(await fs.readdir(path.join(b.jobPath, "output")), []);
  assert.deepEqual(await fs.readFile(path.join(b.jobPath, "RUN_LOG.md")), await fs.readFile(new URL("../templates/RUN_LOG.template.md", import.meta.url)));
});
test("P3 source removal updates source IDs while retaining orphan files", async () => {
  const a = await createJob({ ...input("remove", workflow()), references: [ref(1), ref(2)] });
  const loaded = await loadJob(a.jobPath);
  loaded.job.references.shift();
  await saveJob(a.jobPath, loaded.job);
  const m = await manifest(a.jobPath);
  assert.deepEqual(m.reference_workflow.source_reference_ids, ["REF-001"]);
  assert.equal(m.references[0].note, "note 2");
  assert.equal((await fs.readdir(path.join(a.jobPath, "references"))).length, 2);
});
for (const version of ["1.0", "1.1"]) test("P3 schema " + version + " loads Direct and migrates on SAVE", async () => {
  const a = await createJob(input("legacy" + version));
  a.manifest.schema_version = version;
  a.manifest.composer_version = "old";
  a.manifest.extension = { unknown: true };
  delete a.manifest.reference_workflow;
  await fs.writeFile(path.join(a.jobPath, "manifest.json"), JSON.stringify(a.manifest));
  const loaded = await loadJob(a.jobPath);
  assert.equal(loaded.readOnly, false);
  assert.deepEqual(loaded.job.referenceWorkflow, { mode: "direct" });
  await saveJob(a.jobPath, loaded.job);
  const m = await manifest(a.jobPath);
  assert.equal(m.schema_version, "1.2");
  assert.deepEqual(m.reference_workflow, { mode: "direct" });
  assert.deepEqual(m.extension, { unknown: true });
});
test("P3 future schemas and workflow modes forbid SAVE and SAVE AS", async () => {
  for (const type of ["schema", "workflow"]) {
    const a = await createJob(input("future-" + type, workflow()));
    const editable = await loadJob(a.jobPath);
    if (type === "schema") a.manifest.schema_version = "3.0";
    else a.manifest.reference_workflow.mode = "future_generation";
    await fs.writeFile(path.join(a.jobPath, "manifest.json"), JSON.stringify(a.manifest));
    const before = await snapshot(a.jobPath);
    assert.equal((await loadJob(a.jobPath)).readOnly, true);
    await assert.rejects(saveJob(a.jobPath, editable.job));
    await assert.rejects(saveJobAs(a.jobPath, { ...editable.job, jobName: "blocked-" + type }));
    assert.deepEqual(await snapshot(a.jobPath), before);
  }
});
test("P3 older clients omitting workflow preserve it in SAVE and SAVE AS", async () => {
  const a = await createJob(input("omitted", workflow()));
  const loaded = await loadJob(a.jobPath);
  delete loaded.job.referenceWorkflow;
  await saveJob(a.jobPath, loaded.job);
  assert.deepEqual((await manifest(a.jobPath)).reference_workflow, a.manifest.reference_workflow);
  const b = await saveJobAs(a.jobPath, { ...loaded.job, jobName: "omitted-copy" });
  assert.deepEqual(b.manifest.reference_workflow, a.manifest.reference_workflow);
});
test("P3 switching saved Generate to Direct drops only active generation fields", async () => {
  const a = await createJob({ ...input("switch", workflow()), references: [ref(1)] });
  const loaded = await loadJob(a.jobPath);
  loaded.job.referenceWorkflow = { mode: "direct" };
  await saveJob(a.jobPath, loaded.job);
  const m = await manifest(a.jobPath);
  assert.deepEqual(m.reference_workflow, { mode: "direct" });
  assert.deepEqual(m.references, a.manifest.references);
});
