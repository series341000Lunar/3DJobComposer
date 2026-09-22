import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, JobExistsError, loadJob, saveJob } from "../src/server/job-service.js";

function baseInput(rootPath, overrides = {}) {
  return {
    jobName: "resource_collection_machine_001",
    description: "2040년대 일본 지방도시에 설치되는 무인 자원수거기를 제작한다.\n\n원문을 그대로 보존한다.",
    rootPath,
    asset: { category: "Prop", quality: "Production CG", motion: ["Static"], subject: ["Hard Surface"] },
    target: { purpose: "CGI", dcc: "Blender", unit: "mm" },
    workScope: ["Modeling"],
    deliverables: ["BLEND"],
    referencePackage: { enabled: false, items: [] },
    references: [],
    ...overrides
  };
}

function imageReference(overrides = {}) {
  return {
    originalName: "front.png",
    mimeType: "image/png",
    dataBase64: Buffer.from([0, 1, 2, 3]).toString("base64"),
    existingFile: null,
    missing: false,
    roles: ["Shape", "Lighting"],
    note: "전체 비례와 라이팅을 참고한다.",
    ...overrides
  };
}

test("V1 create: creates the 1.2 package structure without references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-create-"));
  const result = await createJob(baseInput(root));
  const entries = await readdir(result.jobPath);
  assert.deepEqual(entries.sort(), ["RUN_LOG.md", "TASK.md", "manifest.json", "output", "references", "work"].sort());
  assert.equal((await stat(path.join(result.jobPath, "references"))).isDirectory(), true);
  const manifest = JSON.parse(await readFile(path.join(result.jobPath, "manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, "1.2");
  assert.equal(manifest.composer_version, "0.3.0");
  assert.deepEqual(manifest.work_scope, ["Modeling"]);
  assert.deepEqual(manifest.deliverables, ["BLEND"]);
  assert.deepEqual(manifest.references, []);
  assert.match(await readFile(path.join(result.jobPath, "TASK.md"), "utf8"), /No reference images were provided/);
  const runLog = await readFile(path.join(result.jobPath, "RUN_LOG.md"), "utf8");
  assert.match(runLog, /^# RUN LOG/);
  assert.doesNotMatch(runLog, /completed|success/i);
});

test("reference copy: preserves three byte streams, order, roles, and notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-refs-"));
  const referenceData = [
    { originalName: "front.png", mimeType: "image/png", bytes: Buffer.from([0, 1, 2, 3]), roles: ["Shape", "Proportion"], note: "전체 비례와 실루엣만 참고한다." },
    { originalName: "door.JPG", mimeType: "image/jpeg", bytes: Buffer.from([4, 5, 6]), roles: ["Mechanism"], note: "투입구 개폐 메커니즘만 참고한다." },
    { originalName: "surface.webp", mimeType: "image/webp", bytes: Buffer.from([7, 8]), roles: ["Material", "Render Style"], note: "표면 디테일을 유지한다." }
  ];
  const references = referenceData.map(({ bytes, ...item }) => ({ ...item, dataBase64: bytes.toString("base64") }));
  const result = await createJob(baseInput(root, { references }));
  const manifest = JSON.parse(await readFile(path.join(result.jobPath, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.references.map((item) => item.file), ["references/ref_001.png", "references/ref_002.jpg", "references/ref_003.webp"]);
  assert.deepEqual(manifest.references.map((item) => item.note), referenceData.map((item) => item.note));
  for (let index = 0; index < referenceData.length; index += 1) {
    assert.deepEqual(await readFile(path.join(result.jobPath, manifest.references[index].file)), referenceData[index].bytes);
  }
});

test("TEST A: loads an existing Job from manifest and restores reference data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-load-"));
  const created = await createJob(baseInput(root, { references: [imageReference()] }));
  const loaded = await loadJob(created.jobPath);
  assert.equal(loaded.job.jobName, "resource_collection_machine_001");
  assert.equal(loaded.job.description.includes("원문을 그대로 보존한다."), true);
  assert.deepEqual(loaded.job.references[0].roles, ["Shape", "Lighting"]);
  assert.equal(loaded.job.references[0].note, "전체 비례와 라이팅을 참고한다.");
  assert.equal(loaded.job.references[0].missing, false);
  assert.deepEqual(Buffer.from(loaded.job.references[0].dataBase64, "base64"), Buffer.from([0, 1, 2, 3]));
});

test("TEST B: saves edits only after load and retains excluded reference files on disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-save-"));
  const created = await createJob(baseInput(root, { references: [imageReference()] }));
  const runLogPath = path.join(created.jobPath, "RUN_LOG.md");
  const existingRunHistory = "# RUN LOG\n\n## Entries\n\n## Run 001\n\nWorker-authored history.\n";
  await writeFile(runLogPath, existingRunHistory, "utf8");
  const loaded = await loadJob(created.jobPath);
  loaded.job.description = "수정된 설명 원문";
  loaded.job.references[0].roles = ["Material", "Render Style"];
  loaded.job.references[0].note = "수정된 노트";
  await saveJob(created.jobPath, loaded.job);
  let manifest = JSON.parse(await readFile(path.join(created.jobPath, "manifest.json"), "utf8"));
  assert.equal(manifest.job.description, "수정된 설명 원문");
  assert.deepEqual(manifest.references[0].roles, ["Material", "Render Style"]);
  assert.match(await readFile(path.join(created.jobPath, "TASK.md"), "utf8"), /수정된 노트/);
  assert.equal(await readFile(runLogPath, "utf8"), existingRunHistory);

  const originalFile = path.join(created.jobPath, manifest.references[0].file);
  loaded.job.references = [];
  await saveJob(created.jobPath, loaded.job);
  manifest = JSON.parse(await readFile(path.join(created.jobPath, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.references, []);
  assert.equal((await stat(originalFile)).isFile(), true);
  assert.equal(await readFile(runLogPath, "utf8"), existingRunHistory);
});

test("TEST C: new Job creation still refuses overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-duplicate-"));
  await createJob(baseInput(root));
  await assert.rejects(() => createJob(baseInput(root)), JobExistsError);
});

test("TEST D: stores Three-View + Isometric package plan in manifest and TASK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-ai-"));
  const input = baseInput(root, {
    references: [imageReference()],
    referencePackage: {
      enabled: true,
      items: [{
        enabled: true,
        mode: "Three-View + Isometric",
        scope: "Whole Asset",
        sourceReferences: ["REF-001"],
        targetPart: null,
        note: "Front / Side / Rear / ISO 시트 작성"
      }]
    }
  });
  const created = await createJob(input);
  const manifest = JSON.parse(await readFile(path.join(created.jobPath, "manifest.json"), "utf8"));
  assert.equal(manifest.reference_package.enabled, true);
  assert.equal(manifest.reference_package.items[0].mode, "Three-View + Isometric");
  assert.deepEqual(manifest.reference_package.items[0].source_references, ["REF-001"]);
  const task = await readFile(path.join(created.jobPath, "TASK.md"), "utf8");
  assert.match(task, /## AI Reference Package/);
  assert.match(task, /Three-View \+ Isometric/);
  assert.match(task, /Front \/ Side \/ Rear \/ ISO 시트 작성/);
});

test("TEST E: loads a schema 1.0 manifest without reference_package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-legacy-"));
  const jobPath = path.join(root, "legacy_job");
  await mkdir(path.join(jobPath, "references"), { recursive: true });
  await writeFile(path.join(jobPath, "TASK.md"), "# TASK\n", "utf8");
  await writeFile(path.join(jobPath, "manifest.json"), JSON.stringify({
    schema_version: "1.0",
    composer_version: "0.1.0",
    job: { name: "legacy_job", description: "기존 설명" },
    asset: { category: "Prop", quality: "Low Poly", motion: ["Static"], subject: ["Hard Surface"] },
    target: { purpose: "CGI", dcc: "Blender", unit: "m", outputs: ["BLEND"] },
    references: []
  }), "utf8");
  const loaded = await loadJob(jobPath);
  assert.deepEqual(loaded.job.deliverables, ["BLEND"]);
  assert.deepEqual(loaded.job.workScope, ["Unspecified"]);
  assert.deepEqual(loaded.job.referencePackage, { enabled: false, items: [] });
  assert.ok(loaded.warnings.some((warning) => warning.includes("RUN_LOG.md")));
  await saveJob(jobPath, loaded.job);
  assert.match(await readFile(path.join(jobPath, "RUN_LOG.md"), "utf8"), /^# RUN LOG/);
});

test("sanitizes names, rejects relative roots, and trims root whitespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-paths-"));
  const result = await createJob(baseInput(`  ${root}   `, { jobName: "  resource : collection / machine 001... " }));
  assert.equal(path.basename(result.jobPath), "resource_collection_machine_001");
  await assert.rejects(() => createJob(baseInput("relative/jobs")), /absolute path/);
});

test("natural-language-only contract allows unspecified and empty structured fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "3djc-natural-"));
  const created = await createJob(baseInput(root, {
    jobName: "qnap_ts_1655",
    description: "QNAP TS-1655를 만들어주세요.\n필요하면 인터넷에서 3면도나 공식 자료를 찾아주세요.",
    asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
    target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" },
    workScope: ["Unspecified"],
    deliverables: []
  }));
  const manifest = JSON.parse(await readFile(path.join(created.jobPath, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.asset.motion, []);
  assert.deepEqual(manifest.asset.subject, []);
  assert.equal(manifest.target.unit, "Unspecified");
  assert.deepEqual(manifest.deliverables, []);
  assert.match(await readFile(path.join(created.jobPath, "TASK.md"), "utf8"), /필요하면 인터넷에서 3면도나 공식 자료를 찾아주세요\./);
});
