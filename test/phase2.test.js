import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "../src/server/server.js";
import { createJob, loadJob, saveJob, saveJobAs } from "../src/server/job-service.js";
import { listPromptPresets, PRESET_CATEGORIES } from "../src/server/presets.js";
import { readSettings, updateDestinationPreset } from "../src/server/local-settings.js";
let root, server, origin, settingsPath, presetRoot;
before(async () => {
  const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await fs.mkdir(temp, { recursive: true });
  root = await fs.mkdtemp(path.join(temp, "phase2-"));
  settingsPath = path.join(root, "machine", "settings.local.json");
  presetRoot = path.join(root, "missing-presets");
  server = createServer({ settingsPath, presetRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
function input(name) {
  return { jobName: name, rootPath: root, description: "Original Korean 한국어\n**Markdown**",
    asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
    target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" },
    workScope: [], deliverables: [], references: [], referencePackage: { enabled: false, items: [] } };
}
const reference = (note = "Original note") => ({ originalName: "front.png", mimeType: "image/png",
  roles: ["Shape"], note, dataBase64: Buffer.from([0, 1, 2, 3, 255]).toString("base64") });
async function post(endpoint, body, headers = {}) {
  const response = await fetch(origin + endpoint, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function snapshot(directory) {
  const result = {};
  async function visit(dir, prefix = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) { result[key + "/"] = true; await visit(path.join(dir, entry.name), key + "/"); }
      else result[key] = (await fs.readFile(path.join(dir, entry.name))).toString("base64");
    }
  }
  await visit(directory);
  return result;
}
test("P2 T02 SAVE AS creates B, leaves A intact, and grants B's edit context", async () => {
  const a = await createJob(input("T02-A")), before = await snapshot(a.jobPath);
  const loaded = (await post("/api/jobs/load", { jobPath: a.jobPath })).body;
  const result = await post("/api/jobs/save-as", { editToken: loaded.editToken, job: { ...loaded.job, jobName: "T02-B", description: "B edited" } });
  assert.equal(result.status, 201);
  assert.equal(result.body.job.jobName, "T02-B");
  assert.ok(result.body.editToken && result.body.editToken !== loaded.editToken);
  assert.equal((await post("/api/jobs/save", { editToken: result.body.editToken, job: { ...result.body.job, description: "B saved again" } })).status, 200);
  assert.equal((await loadJob(result.body.jobPath)).job.description, "B saved again");
  assert.deepEqual(await snapshot(a.jobPath), before);
});
test("P2 T04 SAVE AS collision leaves both Jobs unchanged without a suffix", async () => {
  const a = await createJob(input("T04-A")), b = await createJob(input("T04-B"));
  const beforeA = await snapshot(a.jobPath), beforeB = await snapshot(b.jobPath);
  const loaded = (await post("/api/jobs/load", { jobPath: a.jobPath })).body;
  assert.equal((await post("/api/jobs/save-as", { editToken: loaded.editToken, job: { ...loaded.job, jobName: "T04-B" } })).status, 409);
  assert.deepEqual(await snapshot(a.jobPath), beforeA);
  assert.deepEqual(await snapshot(b.jobPath), beforeB);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith("T04-B_")), false);
});
test("P2 T05 SAVE AS copies own references and preserves role/note/authoring fields", async () => {
  const a = await createJob({ ...input("T05-A"), references: [reference()] });
  const loaded = await loadJob(a.jobPath);
  loaded.job.references.push(reference("New UI image"));
  const b = await saveJobAs(a.jobPath, { ...loaded.job, jobName: "T05-B" });
  assert.equal(b.manifest.references.length, 2);
  for (const ref of b.manifest.references) {
    assert.match(ref.file, /^references\/ref_\d+.png$/);
    assert.deepEqual(await fs.readFile(path.join(b.jobPath, ref.file)), Buffer.from([0, 1, 2, 3, 255]));
    assert.deepEqual(ref.roles, ["Shape"]);
  }
  assert.equal(b.manifest.references[1].note, "New UI image");
  assert.deepEqual(b.manifest.work_scope, []);
  await fs.rename(path.join(a.jobPath, "references"), path.join(a.jobPath, "references-unavailable"));
  assert.equal((await loadJob(b.jobPath)).job.references.every((ref) => !ref.missing), true);
});
test("P2 T06 SAVE AS creates fresh RUN_LOG and empty work/output", async () => {
  const a = await createJob(input("T06-A"));
  await fs.writeFile(path.join(a.jobPath, "RUN_LOG.md"), "Actual production history");
  await fs.writeFile(path.join(a.jobPath, "work", "source.blend"), "Original work");
  await fs.writeFile(path.join(a.jobPath, "output", "export.glb"), "Original output");
  const before = await snapshot(a.jobPath);
  const b = await saveJobAs(a.jobPath, { ...(await loadJob(a.jobPath)).job, jobName: "T06-B" });
  assert.deepEqual(await fs.readFile(path.join(b.jobPath, "RUN_LOG.md")), await fs.readFile(new URL("../templates/RUN_LOG.template.md", import.meta.url)));
  assert.deepEqual(await fs.readdir(path.join(b.jobPath, "work")), []);
  assert.deepEqual(await fs.readdir(path.join(b.jobPath, "output")), []);
  assert.deepEqual(await snapshot(a.jobPath), before);
});
test("P2 T07 destination presets survive a process restart and support selection data/deletion", async () => {
  const destination = "Z:\\RicochetAngles\\00_Asset\\MODEL";
  assert.equal((await post("/api/settings/destinations", { action: "save", name: "RicochetAngles Models", path: destination })).status, 200);
  const module = new URL("../src/server/local-settings.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {readSettings} from ${JSON.stringify(module)}; console.log(JSON.stringify(await readSettings(${JSON.stringify(settingsPath)})));`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).destinationPresets, [{ name: "RicochetAngles Models", path: destination }]);
  assert.equal((await post("/api/settings/destinations", { action: "delete", name: "RicochetAngles Models" })).status, 200);
  assert.deepEqual((await readSettings(settingsPath)).destinationPresets, []);
});
test("P2 T08 missing PromptPreset root does not prevent server startup", async () => {
  assert.equal((await fetch(origin + "/api/config")).status, 200);
  const result = await (await fetch(origin + "/api/presets")).json();
  assert.deepEqual(result.categories, Object.fromEntries(PRESET_CATEGORIES.map((name) => [name, []])));
  assert.deepEqual(result.warnings, []);
});
test("P2 T09 partial categories and existing Windows casing are discovered", async () => {
  const directory = path.join(root, "T09");
  await fs.mkdir(path.join(directory, "AIReferencePackage"), { recursive: true });
  await fs.writeFile(path.join(directory, "AIReferencePackage", "General.md"), "Data, not execution");
  const result = await listPromptPresets(directory);
  assert.equal(result.categories.AIreferencePackage[0].content, "Data, not execution");
  assert.deepEqual(result.categories.Referenceimage, []);
  assert.deepEqual(result.warnings, []);
});
test("P2 T10 empty folders and unsupported-only folders are normal", async () => {
  const directory = path.join(root, "T10");
  await fs.mkdir(path.join(directory, "jobDescription"), { recursive: true });
  await fs.mkdir(path.join(directory, "Referenceimage"));
  await fs.writeFile(path.join(directory, "Referenceimage", "ignored.json"), "{}");
  const result = await listPromptPresets(directory);
  assert.equal(Object.values(result.categories).every((items) => items.length === 0), true);
  assert.deepEqual(result.warnings, []);
});
test("P2 T11 md/txt discovery, stable filenames and explicit refresh use current bytes", async () => {
  const directory = path.join(root, "T11", "jobDescription");
  await fs.mkdir(directory, { recursive: true });
  for (const file of ["B.txt", "A.md", "C.json", "D.png"]) await fs.writeFile(path.join(directory, file), file);
  let result = await listPromptPresets(path.dirname(directory));
  assert.deepEqual(result.categories.jobDescription.map((item) => item.file), ["A.md", "B.txt"]);
  await fs.writeFile(path.join(directory, "A.md"), "Updated");
  result = await listPromptPresets(path.dirname(directory));
  assert.equal(result.categories.jobDescription[0].content, "Updated");
});
test("P2 T12 exact UTF-8 filename and full Markdown/newlines are returned", async () => {
  const directory = path.join(root, "T12", "jobDescription"), file = "RicochetAngles_한국어.Default.md", content = "# 제목\r\n\r\n**원문**  \n";
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, file), content);
  assert.deepEqual((await listPromptPresets(path.dirname(directory))).categories.jobDescription, [{ file, content }]);
});
test("P2 T13 description snapshot is retained through LOAD/SAVE/SAVE AS", async () => {
  const content = "# 한국어\r\n\r\n**원문**\n";
  const preset = { file: "Original.md", resolved_content: content };
  const a = await createJob({ ...input("T13-A"), description: content, descriptionPreset: preset });
  const loaded = await loadJob(a.jobPath);
  await saveJob(a.jobPath, loaded.job);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(a.jobPath, "manifest.json"))), a.manifest);
  const b = await saveJobAs(a.jobPath, { ...loaded.job, jobName: "T13-B", description: "Manual edit after applying" });
  assert.deepEqual(b.manifest.metadata.job_description_preset, preset);
  assert.equal(b.manifest.job.description, "Manual edit after applying");
  assert.equal(b.manifest.schema_version, "1.1");
});
test("P2 T14 reference note snapshots follow their files and removal clears only their metadata", async () => {
  const preset = { file: "ShapeOnly.md", resolved_content: "형태만 참고\r\n" };
  const a = await createJob({ ...input("T14-A"), references: [{ ...reference(preset.resolved_content), notePreset: preset }, reference("Other")] });
  const loaded = await loadJob(a.jobPath);
  assert.deepEqual(loaded.job.references[0].notePreset, preset);
  assert.equal(loaded.job.references[1].notePreset, null);
  const b = await saveJobAs(a.jobPath, { ...loaded.job, jobName: "T14-B" });
  assert.deepEqual(b.manifest.metadata.reference_note_presets["references/ref_001.png"], preset);
  loaded.job.references.shift();
  await saveJob(a.jobPath, loaded.job);
  const manifest = JSON.parse(await fs.readFile(path.join(a.jobPath, "manifest.json")));
  assert.equal(manifest.metadata.reference_note_presets, undefined);
  assert.equal(manifest.references[0].note, "Other");
  assert.deepEqual(manifest.references[0].roles, ["Shape"]);
});
test("P2 T15 future schema cannot use an old edit token for SAVE AS", async () => {
  const a = await createJob(input("T15-A"));
  const loaded = (await post("/api/jobs/load", { jobPath: a.jobPath })).body;
  a.manifest.schema_version = "2.0";
  await fs.writeFile(path.join(a.jobPath, "manifest.json"), JSON.stringify(a.manifest));
  const before = await snapshot(a.jobPath);
  assert.equal((await post("/api/jobs/save-as", { editToken: loaded.editToken, job: { ...loaded.job, jobName: "T15-B" } })).status, 409);
  assert.deepEqual(await snapshot(a.jobPath), before);
  assert.equal((await fs.readdir(root)).includes("T15-B"), false);
});
test("P2 T16 new write endpoints enforce Origin/Content-Type and edit token", async () => {
  const before = await readSettings(settingsPath);
  for (const endpoint of ["/api/jobs/save-as", "/api/settings/destinations"]) {
    assert.equal((await post(endpoint, {}, { Origin: "https://external.invalid" })).status, 403);
    assert.equal((await post(endpoint, {}, { "Content-Type": "text/plain" })).status, 415);
  }
  assert.equal((await post("/api/jobs/save-as", { editToken: "invalid", job: input("T16-B") })).status, 403);
  assert.deepEqual(await readSettings(settingsPath), before);
});
test("P2 T17 SAVE AS cannot copy unlisted or missing source reference paths", async () => {
  const a = await createJob({ ...input("T17-A"), references: [reference()] });
  const loaded = await loadJob(a.jobPath);
  loaded.job.references[0].existingFile = "../RUN_LOG.md";
  await assert.rejects(saveJobAs(a.jobPath, { ...loaded.job, jobName: "T17-B" }), /every retained reference/);
  const valid = await loadJob(a.jobPath);
  await fs.rename(path.join(a.jobPath, "references", "ref_001.png"), path.join(a.jobPath, "references", "moved.png"));
  await assert.rejects(saveJobAs(a.jobPath, { ...valid.job, jobName: "T17-B" }), /every retained reference/);
  assert.equal((await fs.readdir(root)).includes("T17-B"), false);
});
test("P2 T18 settings preserve unknown data and corrupted files are never overwritten", async () => {
  const file = path.join(root, "T18-settings.json");
  await fs.writeFile(file, JSON.stringify({ extra: { unknown: true }, destinationPresets: [] }));
  await updateDestinationPreset({ action: "save", name: "A", path: root }, file);
  assert.deepEqual((await readSettings(file)).extra, { unknown: true });
  await fs.writeFile(file, "{broken");
  await assert.rejects(updateDestinationPreset({ action: "save", name: "B", path: root }, file), /preserved/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});
test("P2 T19 queued destination writes retain both entries", async () => {
  const file = path.join(root, "T19-settings.json");
  await Promise.all(["A", "B"].map((name) => updateDestinationPreset({ action: "save", name, path: root }, file)));
  assert.deepEqual((await readSettings(file)).destinationPresets.map((item) => item.name), ["A", "B"]);
});
test("P2 T20 preset provenance validation fails before creating a Job", async () => {
  await assert.rejects(createJob({ ...input("T20"), descriptionPreset: { file: "../outside.md", resolved_content: "text" } }), /Invalid preset identity/);
  assert.equal((await fs.readdir(root)).includes("T20"), false);
});

test("P2 T21 omitted optional preset fields preserve provenance for older clients", async () => {
  const preset = { file: "Preserve.md", resolved_content: "Applied source" };
  const a = await createJob({ ...input("T21-A"), descriptionPreset: preset,
    references: [{ ...reference(), notePreset: preset }] });
  const loaded = await loadJob(a.jobPath);
  delete loaded.job.descriptionPreset;
  delete loaded.job.references[0].notePreset;
  await saveJob(a.jobPath, loaded.job);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(a.jobPath, "manifest.json"))), a.manifest);
  const b = await saveJobAs(a.jobPath, { ...loaded.job, jobName: "T21-B" });
  assert.deepEqual(b.manifest.metadata.job_description_preset, preset);
  assert.deepEqual(b.manifest.metadata.reference_note_presets["references/ref_001.png"], preset);
});
