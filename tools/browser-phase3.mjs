import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "../src/server/server.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await fs.mkdtemp(fileURLToPath(new URL("../.tmp/browser-phase3-", import.meta.url)));
const presetRoot = path.join(root, "PromptPreset");
const master = "# 원문 Master\r\n\r\nCreate an original shape.\n";
const packageText = "# Package\r\nUse these views for modeling.\n";
for (const [category, text] of [["GenerateMasterReference", master], ["AIreferencePackage", packageText], ["Referenceimage", "Note preset"]]) {
  await fs.mkdir(path.join(presetRoot, category), { recursive: true });
  await fs.writeFile(path.join(presetRoot, category, "Original.md"), text);
}
const server = createServer({ presetRoot, settingsPath: path.join(root, "settings.local.json") });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64");
const errors = [], external = [], checks = [];
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(origin + "/")) external.push(r.url()); });
  const field = (id) => page.locator("#" + id);
  async function dialogClick(id, message, accept) {
    const seen = new Promise((resolve, reject) => page.once("dialog", async (d) => {
      try { assert.equal(d.message(), message); await (accept ? d.accept() : d.dismiss()); resolve(); } catch (e) { reject(e); }
    }));
    await field(id).click(); await seen;
  }
  async function load(name) {
    await field("load-job-path").fill(path.join(root, name));
    const response = page.waitForResponse((r) => r.url().endsWith("/api/jobs/load"));
    await field("load-job-button").click(); assert.equal((await response).status(), 200);
    await field("status").filter({ hasText: "Job loaded." }).waitFor();
  }
  async function save(name, mode = "create") {
    const endpoint = mode === "as" ? "/api/jobs/save-as" : mode === "save" ? "/api/jobs/save" : "/api/jobs";
    const response = page.waitForResponse((r) => r.url().endsWith(endpoint));
    if (mode === "create") await field("create-button").click();
    else await dialogClick(mode === "as" ? "save-as-button" : "create-button", mode === "as" ? "새로 저장하시겠습니까?" : "덮어쓰시겠습니까?", true);
    const result = await response;
    assert.ok(result.ok(), await result.text());
    await field("status").filter({ hasText: mode === "save" ? "Job saved successfully." : "Job created successfully." }).waitFor();
    return JSON.parse(await fs.readFile(path.join(root, name, "manifest.json"), "utf8"));
  }
  await page.goto(origin);
  await field("master-preset").locator("option").filter({ hasText: "Original.md" }).waitFor({ state: "attached" });
  assert.equal(await field("workflow-direct").isChecked(), true);
  await field("job-name").fill("Direct");
  await field("root-path").fill(root);
  await field("description").fill("Direct reference request");
  await field("reference-input").setInputFiles({ name: "direct.png", mimeType: "image/png", buffer: image });
  await page.locator(".reference-roles label").filter({ hasText: /^Shape$/ }).click();
  await page.locator(".reference-note").fill("Use silhouette");
  let m = await save("Direct");
  assert.deepEqual(m.reference_workflow, { mode: "direct" });
  await load("Direct");
  assert.equal(await page.locator(".reference-note").inputValue(), "Use silhouette");
  await save("Direct", "save");
  checks.push("Direct CREATE/LOAD/SAVE preserves image, roles and note");

  await field("new-job-button").click();
  await field("job-name").fill("Zero");
  await field("description").fill("Generate before modeling");
  await field("workflow-generate").locator("..").click();
  await field("master-preset").selectOption("Original.md");
  assert.equal(await field("master-instruction").inputValue(), "");
  await field("apply-master-preset").click();
  await field("master-instruction").fill("User edited final instruction");
  await dialogClick("apply-master-preset", "현재 지시문을 프리셋 내용으로 교체하시겠습니까?", false);
  assert.equal(await field("master-instruction").inputValue(), "User edited final instruction");
  await field("package-instruction-preset").selectOption("Original.md");
  await field("apply-package-instruction-preset").click();
  await field("package-instruction-instruction").fill("Edited package usage");
  await dialogClick("apply-package-instruction-preset", "현재 지시문을 프리셋 내용으로 교체하시겠습니까?", false);
  assert.equal(await field("package-instruction-instruction").inputValue(), "Edited package usage");
  await dialogClick("apply-package-instruction-preset", "현재 지시문을 프리셋 내용으로 교체하시겠습니까?", true);
  await field("workflow-direct").locator("..").click();
  assert.equal(await field("master-workflow-fields").isVisible(), false);
  await field("workflow-generate").locator("..").click();
  assert.equal(await field("master-instruction").inputValue(), "User edited final instruction");
  m = await save("Zero");
  assert.equal(m.references.length, 0);
  assert.equal(m.reference_workflow.generate_master_reference.preset_snapshot, master);
  assert.equal(m.reference_workflow.generate_master_reference.effective_instruction, "User edited final instruction");
  assert.equal(m.reference_workflow.ai_reference_package.effective_instruction, packageText);
  await load("Zero");
  assert.equal(await field("workflow-generate").isChecked(), true);
  assert.equal(await field("master-instruction").inputValue(), "User edited final instruction");
  await save("Zero", "save");
  checks.push("Zero-image generation; explicit APPLY/cancel; independent snapshots/effective text; CRLF round-trip; toggle retains drafts");

  await fs.unlink(path.join(presetRoot, "GenerateMasterReference", "Original.md"));
  await fs.writeFile(path.join(presetRoot, "AIreferencePackage", "Original.md"), "Changed on disk");
  await field("refresh-presets").click();
  await field("master-preset-status").filter({ hasText: "unavailable" }).waitFor();
  await field("package-instruction-preset-status").filter({ hasText: "has changed" }).waitFor();
  await load("Zero");
  assert.equal(await field("master-preset").inputValue(), "");
  assert.equal(await field("master-preset").locator("option:checked").textContent(), "No presets available");
  assert.equal(await field("master-instruction").inputValue(), "User edited final instruction");
  assert.equal(await field("package-instruction-instruction").inputValue(), packageText.replace(/\r\n/g, "\n"));
  m = await save("Zero", "save");
  assert.equal(m.reference_workflow.generate_master_reference.preset_snapshot, master);
  await page.screenshot({ path: path.join(root, "generate-missing-preset.png"), fullPage: true });
  checks.push("Missing/changed source presets warn without blocking LOAD/SAVE or replacing saved instructions");

  await field("reference-input").setInputFiles([
    { name: "shape.png", mimeType: "image/png", buffer: image },
    { name: "material.png", mimeType: "image/png", buffer: image }
  ]);
  const first = page.locator(".reference-card").nth(0), second = page.locator(".reference-card").nth(1);
  await first.locator(".reference-roles label").filter({ hasText: /^Shape$/ }).click();
  await second.locator(".reference-roles label").filter({ hasText: /^Material$/ }).click();
  await first.locator(".reference-preset").selectOption("Original.md");
  await first.locator(".apply-reference-preset").click();
  await first.locator(".reference-note").fill("Shape edited");
  await second.locator(".reference-note").fill("Material only");
  await field("workflow-direct").locator("..").click(); await field("workflow-generate").locator("..").click();
  assert.equal(await first.locator(".reference-note").inputValue(), "Shape edited");
  await field("job-name").fill("Multi");
  m = await save("Multi", "as");
  assert.deepEqual(m.reference_workflow.source_reference_ids, ["REF-001", "REF-002"]);
  assert.deepEqual(m.references.map((r) => r.roles), [["Shape"], ["Material"]]);
  assert.deepEqual(m.references.map((r) => r.note), ["Shape edited", "Material only"]);
  assert.equal(m.metadata.reference_note_presets[m.references[0].file].resolved_content, "Note preset");
  await load("Multi"); await save("Multi", "save");
  for (const ref of m.references) assert.deepEqual(await fs.readFile(path.join(root, "Multi", ref.file)), image);
  await fs.writeFile(path.join(root, "Multi", "work", "master.png"), "existing generated output");
  await fs.writeFile(path.join(root, "Multi", "output", "model.blend"), "existing model");
  await fs.writeFile(path.join(root, "Multi", "RUN_LOG.md"), "existing production history");
  await save("Multi", "save");
  assert.equal(await fs.readFile(path.join(root, "Multi", "work", "master.png"), "utf8"), "existing generated output");
  await field("job-name").fill("MultiCopy");
  const copy = await save("MultiCopy", "as");
  assert.deepEqual(copy.reference_workflow, m.reference_workflow);
  for (const dir of ["work", "output"]) assert.deepEqual(await fs.readdir(path.join(root, "MultiCopy", dir)), []);
  assert.deepEqual(await fs.readFile(path.join(root, "MultiCopy", "RUN_LOG.md")), await fs.readFile(new URL("../templates/RUN_LOG.template.md", import.meta.url)));
  await page.screenshot({ path: path.join(root, "multi-copy.png"), fullPage: true });
  checks.push("Multiple sources retain distinct roles/notes/presets and bytes across LOAD/SAVE/SAVE AS; runtime preserved only in source");

  await field("master-instruction").fill("");
  await field("workflow-direct").locator("..").click();
  m = await save("MultiCopy", "save");
  assert.deepEqual(m.reference_workflow, { mode: "direct" });
  await field("workflow-generate").locator("..").click();
  assert.equal(await field("master-instruction").inputValue(), "");
  checks.push("Inactive incomplete generation fields do not block Direct SAVE");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const report = { result: "PASS", browser: await browser.version(), root, checks, consoleErrors: errors, externalRequests: external };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
