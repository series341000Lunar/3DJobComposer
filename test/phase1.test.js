import http from "node:http";
import { spawnSync } from "node:child_process";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, loadJob, saveJob } from "../src/server/job-service.js";
import { recoverSave, recoveryStatus } from "../src/server/save-transaction.js";
import { server } from "../src/server/server.js";

const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
let root, origin;
before(async () => {
  await fs.mkdir(temp, { recursive: true });
  root = await fs.mkdtemp(path.join(temp, "phase1-"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
const input = (name) => ({
  rootPath: root, jobName: name, description: "Original description\nSecond line.",
  asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
  target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" },
  workScope: [], deliverables: [], references: [], referencePackage: { enabled: false, items: [] }
});
const reference = () => ({ originalName: "tiny.png", mimeType: "image/png", roles: [], note: "original",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=" });
async function post(endpoint, body, headers = {}) {
  const response = await fetch(origin + endpoint, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function fixture(name) { return createJob(input(name)); }
async function snapshot(jobPath) {
  const result = {};
  async function visit(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) { result[key + "/"] = true; await visit(path.join(directory, entry.name), key + "/"); }
      else result[key] = (await fs.readFile(path.join(directory, entry.name))).toString("base64");
    }
  }
  await visit(jobPath);
  return result;
}
async function fault(operation, predicate, run) {
  const original = fs[operation];
  fs[operation] = async (...args) => {
    if (predicate(...args)) throw Object.assign(new Error("Injected filesystem failure"), { code: "EACCES" });
    return original(...args);
  };
  syncBuiltinESMExports();
  try { return await run(); } finally { fs[operation] = original; syncBuiltinESMExports(); }
}
test("T01 HTTP loaded SAVE CHANGES updates the exact folder", async () => {
  const created = await post("/api/jobs", input("T01"));
  assert.equal(created.status, 201);
  const loaded = await post("/api/jobs/load", { jobPath: created.body.jobPath });
  loaded.body.job.description = "Edited via HTTP";
  loaded.body.job.rootPath = path.join(root, "must-not-be-used");
  const saved = await post("/api/jobs/save", { editToken: loaded.body.editToken, job: loaded.body.job, jobPath: root });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.jobPath, created.body.jobPath);
  assert.equal((await loadJob(saved.body.jobPath)).job.description, "Edited via HTTP");
  assert.equal((await fs.readdir(root)).includes("must-not-be-used"), false);
  assert.match(await fs.readFile(path.join(saved.body.jobPath, "TASK.md"), "utf8"), /Edited via HTTP/);
});
test("T02 new Job collision returns 409 and preserves every byte", async () => {
  const created = await fixture("T02"), before = await snapshot(created.jobPath);
  assert.equal((await post("/api/jobs", input("T02"))).status, 409);
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T03 invalid token returns 403 without mutation", async () => {
  const created = await fixture("T03"), before = await snapshot(created.jobPath);
  assert.equal((await post("/api/jobs/save", { editToken: "invalid", job: input("T03"), jobPath: created.jobPath })).status, 403);
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T04 save response reference mapping makes repeated SAVE idempotent", async () => {
  const created = await fixture("T04");
  const loaded = (await post("/api/jobs/load", { jobPath: created.jobPath })).body;
  loaded.job.references.push(reference(), reference());
  const first = await post("/api/jobs/save", { editToken: loaded.editToken, job: loaded.job });
  assert.equal(first.status, 200);
  loaded.job.references.forEach((ref, index) => Object.assign(ref, first.body.references[index], { dataBase64: null }));
  const before = await snapshot(created.jobPath);
  const second = await post("/api/jobs/save", { editToken: loaded.editToken, job: loaded.job });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.references, first.body.references);
  assert.equal((await fs.readdir(path.join(created.jobPath, "references"))).length, 2);
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T05 no-op preserves complete supported semantics, original name and empty arrays", async () => {
  const created = await createJob({ ...input("Original : Name"), references: [reference()] });
  const before = await snapshot(created.jobPath);
  await saveJob(created.jobPath, (await loadJob(created.jobPath)).job);
  assert.deepEqual(await snapshot(created.jobPath), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(created.jobPath, "manifest.json"))).job.original_name, "Original : Name");
});
test("T05b no-op retains absent, null, unspecified and extension data distinctly", async () => {
  for (const variant of ["absent", null, [], ["Unspecified"]]) {
    const created = await fixture("T05b-" + (variant === null ? "null" : JSON.stringify(variant)));
    const manifest = created.manifest;
    if (variant === "absent") delete manifest.work_scope; else manifest.work_scope = variant;
    manifest.custom_extension = { nested: [null, {}, []] };
    manifest.asset.extra = null;
    await fs.writeFile(path.join(created.jobPath, "manifest.json"), JSON.stringify(manifest));
    await saveJob(created.jobPath, (await loadJob(created.jobPath)).job);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(created.jobPath, "manifest.json"))), manifest);
  }
});
test("T06 future/unknown schemas inspect read-only, have no edit token, and reject service save", async () => {
  for (const schema of ["2.0", "1.10", "unknown"]) {
    const created = await fixture("T06-" + schema);
    created.manifest.schema_version = schema;
    created.manifest.custom_future_field = { future: true };
    await fs.writeFile(path.join(created.jobPath, "manifest.json"), JSON.stringify(created.manifest));
    const before = await snapshot(created.jobPath);
    const loaded = await post("/api/jobs/load", { jobPath: created.jobPath });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.readOnly, true);
    assert.equal(loaded.body.editToken, null);
    assert.equal((await post("/api/jobs/save", { editToken: loaded.body.editToken, job: loaded.body.job })).status, 403);
    await assert.rejects(saveJob(created.jobPath, loaded.body.job), /read-only/);
    assert.deepEqual(await snapshot(created.jobPath), before);
  }
});
test("T06b changing schema after LOAD still blocks an already-issued token", async () => {
  const created = await fixture("T06b");
  const loaded = (await post("/api/jobs/load", { jobPath: created.jobPath })).body;
  created.manifest.schema_version = "2.0";
  await fs.writeFile(path.join(created.jobPath, "manifest.json"), JSON.stringify(created.manifest));
  const before = await snapshot(created.jobPath);
  assert.equal((await post("/api/jobs/save", { editToken: loaded.editToken, job: loaded.job })).status, 409);
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T07 manifest staging failure preserves previous complete state", async () => {
  const created = await fixture("T07"), before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.description = "NEW";
  await fault("writeFile", (target) => String(target).endsWith("staged-0"), async () => {
    await assert.rejects(saveJob(created.jobPath, loaded.job), (error) => error.recovery.state === "rolled_back");
  });
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T08 TASK commit failure after manifest commit rolls back all files", async () => {
  const created = await fixture("T08"), before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.description = "NEW"; loaded.job.references.push(reference());
  let sawNewManifest = false;
  const original = fs.copyFile;
  fs.copyFile = async (source, target, ...rest) => {
    if (String(target) === path.join(created.jobPath, "TASK.md")) {
      sawNewManifest = JSON.parse(await fs.readFile(path.join(created.jobPath, "manifest.json"))).job.description === "NEW";
      throw new Error("Injected TASK commit failure");
    }
    return original(source, target, ...rest);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(saveJob(created.jobPath, loaded.job), (error) => error.recovery.state === "rolled_back"); }
  finally { fs.copyFile = original; syncBuiltinESMExports(); }
  assert.equal(sawNewManifest, true);
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T08b reference commit failure rolls back new files and both documents", async () => {
  const created = await fixture("T08b"), before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.references.push(reference(), reference());
  await fault("copyFile", (_source, target) => String(target).endsWith("ref_002.png"), async () => {
    await assert.rejects(saveJob(created.jobPath, loaded.job), (error) => error.recovery.state === "rolled_back");
  });
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T08c failed rollback reports recovery path, blocks SAVE and permits explicit verified recovery", async () => {
  const created = await fixture("T08c"), before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.description = "NEW";
  await fault("copyFile", (_source, target) => String(target).endsWith("TASK.md"), async () => {
    await fault("writeFile", (target) => String(target) === path.join(created.jobPath, "manifest.json"), async () => {
      await assert.rejects(saveJob(created.jobPath, loaded.job), (error) =>
        error.recovery.state === "recovery_required" && error.message.includes(".composer-save-recovery"));
    });
  });
  assert.equal((await loadJob(created.jobPath)).readOnly, true);
  await assert.rejects(saveJob(created.jobPath, loaded.job), /recovery is pending/);
  assert.equal((await recoverSave(created.jobPath)).state, "rolled_back");
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T09 repeated SAVE leaves existing binary RUN_LOG byte-for-byte intact", async () => {
  const created = await fixture("T09");
  const bytes = Buffer.from([0xff, 0xfe, 0, 13, 10, 1, 2, 3]);
  await fs.writeFile(path.join(created.jobPath, "RUN_LOG.md"), bytes);
  for (let i = 0; i < 3; i++) {
    const loaded = await loadJob(created.jobPath); loaded.job.description = "Edit " + i;
    await saveJob(created.jobPath, loaded.job);
    assert.deepEqual(await fs.readFile(path.join(created.jobPath, "RUN_LOG.md")), bytes);
  }
});
test("T10 external/missing/null Origin rejected before CREATE, LOAD and SAVE", async () => {
  const before = await fs.readdir(root);
  for (const Origin of ["https://external.invalid", "null", ""]) {
    for (const endpoint of ["/api/jobs", "/api/jobs/load", "/api/jobs/save", "/api/open-folder"]) {
      assert.equal((await post(endpoint, input("T10"), { Origin })).status, 403);
    }
  }
  assert.deepEqual(await fs.readdir(root), before);
  assert.equal((await post("/api/jobs", input("T10-allowed"))).status, 201);
  assert.equal((await post("/api/jobs", input("T10-localhost"), { Origin: origin.replace("127.0.0.1", "localhost") })).status, 201);
});
test("T11 invalid Content-Type rejected before filesystem mutation", async () => {
  const before = await fs.readdir(root);
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    assert.equal((await post("/api/jobs", input("T11"), { "Content-Type": type })).status, 415);
  }
  assert.deepEqual(await fs.readdir(root), before);
});
test("T12 invalid Host rejected even with an allowed Origin", async () => {
  const status = await new Promise((resolve, reject) => {
    const request = http.request(origin + "/api/jobs", { method: "POST",
      headers: { Host: "attacker.invalid", Origin: origin, "Content-Type": "application/json" } },
      (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end(JSON.stringify(input("T12")));
  });
  assert.equal(status, 403);
});
test("T13 missing RUN_LOG creation failure restores documents and missing-file state", async () => {
  const created = await fixture("T13");
  await fs.unlink(path.join(created.jobPath, "RUN_LOG.md"));
  const before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.description = "NEW";
  await fault("copyFile", (_source, target) => String(target).endsWith("RUN_LOG.md"), async () => {
    await assert.rejects(saveJob(created.jobPath, loaded.job), /previous state restored/);
  });
  assert.deepEqual(await snapshot(created.jobPath), before);
});
test("T14 cleanup failure reports committed state and recovery retains new data", async () => {
  const created = await fixture("T14");
  const loaded = await loadJob(created.jobPath); loaded.job.description = "COMMITTED NEW";
  await fault("rm", (target) => String(target).endsWith("journal.json"), async () => {
    const result = await saveJob(created.jobPath, loaded.job);
    assert.equal(result.recovery.state, "committed_cleanup_required");
  });
  assert.ok(await recoveryStatus(created.jobPath));
  assert.equal((await recoverSave(created.jobPath)).state, "committed");
  assert.equal((await loadJob(created.jobPath)).job.description, "COMMITTED NEW");
});

test("T15 process interruption after manifest commit leaves a recoverable journal", async () => {
  const created = await fixture("T15"), before = await snapshot(created.jobPath);
  const serviceUrl = new URL("../src/server/job-service.js", import.meta.url).href;
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { loadJob, saveJob } from ${JSON.stringify(serviceUrl)};
    const original = fs.copyFile;
    fs.copyFile = async (source, target, ...rest) => {
      if (String(target).endsWith("TASK.md")) process.exit(77);
      return original(source, target, ...rest);
    };
    syncBuiltinESMExports();
    const loaded = await loadJob(${JSON.stringify(created.jobPath)});
    loaded.job.description = "Interrupted NEW";
    await saveJob(loaded.jobPath, loaded.job);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 77, child.stderr);
  assert.equal((await loadJob(created.jobPath)).readOnly, true);
  assert.equal((await recoverSave(created.jobPath)).state, "rolled_back");
  assert.deepEqual(await snapshot(created.jobPath), before);
});

test("T16 partial manifest and failed rollback still expose explicit recovery on LOAD", async () => {
  const created = await fixture("T16"), before = await snapshot(created.jobPath);
  const loaded = await loadJob(created.jobPath); loaded.job.description = "NEW";
  const originalCopy = fs.copyFile, originalWrite = fs.writeFile;
  fs.copyFile = async (source, target, ...rest) => {
    if (String(target) === path.join(created.jobPath, "manifest.json")) {
      await originalWrite(target, "{partial");
      throw new Error("Injected partial manifest write");
    }
    return originalCopy(source, target, ...rest);
  };
  fs.writeFile = async (target, ...rest) => {
    if (String(target) === path.join(created.jobPath, "manifest.json")) throw new Error("Injected rollback failure");
    return originalWrite(target, ...rest);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(saveJob(created.jobPath, loaded.job), (error) => error.recovery.state === "recovery_required"); }
  finally { fs.copyFile = originalCopy; fs.writeFile = originalWrite; syncBuiltinESMExports(); }
  const response = await post("/api/jobs/load", { jobPath: created.jobPath });
  assert.equal(response.status, 400);
  assert.equal(response.body.recovery.state, "recovery_required");
  assert.match(response.body.error, /composer-save-recovery/);
  assert.equal((await recoverSave(created.jobPath)).state, "rolled_back");
  assert.deepEqual(await snapshot(created.jobPath), before);
});

test("T17 interrupted cleanup after journal removal reports cleanup without claiming old state", async () => {
  const created = await fixture("T17");
  const loaded = await loadJob(created.jobPath); loaded.job.description = "Saved NEW";
  await fault("rm", (target) => path.basename(String(target)) === ".composer-save-recovery", async () => {
    assert.equal((await saveJob(created.jobPath, loaded.job)).recovery.state, "committed_cleanup_required");
  });
  assert.equal((await recoverSave(created.jobPath)).state, "cleanup_completed");
  assert.equal((await loadJob(created.jobPath)).job.description, "Saved NEW");
});
