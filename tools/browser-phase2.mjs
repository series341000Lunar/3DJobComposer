import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "../src/server/server.js";
import { createJob } from "../src/server/job-service.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
await fs.mkdir(temp, { recursive: true });
const root = await fs.mkdtemp(path.join(temp, "browser-phase2-"));
const presetRoot = path.join(root, "PromptPreset"), settingsPath = path.join(root, "machine", "settings.local.json");
const server = createServer({ presetRoot, settingsPath });
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64");
const job = (name) => ({ jobName: name, rootPath: root, description: "Original description",
  asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
  target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" }, workScope: [], deliverables: [],
  references: ["First note", "Second note"].map((note) => ({ originalName: "synthetic.png", mimeType: "image/png",
    dataBase64: image.toString("base64"), roles: ["Shape"], note })) });
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
let browser;
const errors = [], checks = [], writes = [];
try {
  const a = await createJob(job("Browser_A"));
  await fs.writeFile(path.join(a.jobPath, "RUN_LOG.md"), "Original production history\r\n");
  await fs.writeFile(path.join(a.jobPath, "work", "asset.blend"), "original work");
  await fs.writeFile(path.join(a.jobPath, "output", "asset.glb"), "original output");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { if (request.method() === "POST") writes.push(request.url()); });
  async function dialogClick(locator, expected, accept, promptValue) {
    const seen = new Promise((resolve, reject) => page.once("dialog", async (dialog) => {
      try {
        assert.equal(dialog.message(), expected);
        if (accept) await dialog.accept(promptValue); else await dialog.dismiss();
        resolve();
      } catch (error) { reject(error); }
    }));
    await locator.click();
    await seen;
  }
  async function saved() { await page.locator("#status").filter({ hasText: "saved successfully" }).waitFor(); }
  await page.goto(url);
  await page.locator("#version").filter({ hasText: "schema 1.1" }).waitFor();
  assert.deepEqual(await page.locator("#description-preset option").allTextContents(), ["No presets available"]);
  checks.push("Missing preset folders: manual UI starts normally");
  await page.locator("#load-job-path").fill(a.jobPath);
  await page.locator("#load-job-button").click();
  await page.locator("#mode-title").filter({ hasText: "Editing Existing Job" }).waitFor();
  await page.locator("#description").fill("Unsaved browser edit");
  await page.locator("#reference-input").setInputFiles({ name: "new.png", mimeType: "image/png", buffer: image });
  const beforeCancel = await snapshot(a.jobPath), requestsBefore = writes.length;
  const stateBefore = await page.locator("#job-form").innerText();
  await dialogClick(page.locator("#create-button"), "덮어쓰시겠습니까?", false);
  assert.equal(writes.length, requestsBefore);
  assert.deepEqual(await snapshot(a.jobPath), beforeCancel);
  assert.equal(await page.locator("#description").inputValue(), "Unsaved browser edit");
  assert.equal(await page.locator("#job-form").innerText(), stateBefore);
  assert.equal(await page.locator(".reference-card").count(), 3);
  checks.push("SAVE CHANGES exact confirmation; Cancel sends no HTTP and changes no disk or edit state");
  await page.locator("#job-name").fill("Browser_B");
  const label = await page.locator("#loaded-job-label").innerText();
  await dialogClick(page.locator("#save-as-button"), "새로 저장하시겠습니까?", false);
  assert.equal(writes.length, requestsBefore);
  assert.equal(await page.locator("#loaded-job-label").innerText(), label);
  assert.equal(await page.locator("#job-name").inputValue(), "Browser_B");
  await assert.rejects(fs.access(path.join(root, "Browser_B")));
  assert.deepEqual(await snapshot(a.jobPath), beforeCancel);
  checks.push("SAVE AS Cancel retains active source and unsaved new name");
  await page.locator("#root-path").fill(path.join(root, "not-the-loaded-root"));
  await dialogClick(page.locator("#create-button"), "덮어쓰시겠습니까?", true);
  await saved();
  assert.equal(JSON.parse(await fs.readFile(path.join(a.jobPath, "manifest.json"))).job.description, "Unsaved browser edit");
  await assert.rejects(fs.access(path.join(root, "not-the-loaded-root")));
  assert.equal((await fs.readdir(path.join(a.jobPath, "references"))).length, 3);
  const sourceBeforeSaveAs = await snapshot(a.jobPath);
  checks.push("SAVE CHANGES confirm uses the exact loaded folder despite edited Save As name/root");

  const description = "# 원문 제목\r\n\r\n**Markdown**  \n마지막 줄\n";
  const note = "형태만 참고하세요.\r\nMaterial is text, not a Role change.\n";
  for (const category of ["jobDescription", "Referenceimage", "AIreferencePackage", "GenerateMasterReference"]) {
    await fs.mkdir(path.join(presetRoot, category), { recursive: true });
  }
  const descriptionFile = "RicochetAngles_한국어.Default.md";
  await fs.writeFile(path.join(presetRoot, "jobDescription", descriptionFile), description);
  await fs.writeFile(path.join(presetRoot, "jobDescription", "Text.txt"), "Plain text");
  await fs.writeFile(path.join(presetRoot, "jobDescription", "ignored.json"), "{}");
  await fs.writeFile(path.join(presetRoot, "Referenceimage", "ShapeOnly.md"), note);
  await fs.writeFile(path.join(presetRoot, "AIreferencePackage", "Plan.md"), "Discovery only");
  await fs.writeFile(path.join(presetRoot, "GenerateMasterReference", "Future.txt"), "No execution");
  await page.locator("#refresh-presets").click();
  await page.locator("#description-preset option").filter({ hasText: descriptionFile }).waitFor({ state: "attached" });
  assert.deepEqual(await page.locator("#description-preset option").allTextContents(), ["Select a preset", descriptionFile, "Text.txt"]);
  await page.locator("#description-preset").selectOption(descriptionFile);
  assert.equal(await page.locator("#description").inputValue(), "Unsaved browser edit");
  await dialogClick(page.locator("#apply-description-preset"), "현재 Job Description을 프리셋 내용으로 교체하시겠습니까?", false);
  assert.equal(await page.locator("#description").inputValue(), "Unsaved browser edit");
  await dialogClick(page.locator("#apply-description-preset"), "현재 Job Description을 프리셋 내용으로 교체하시겠습니까?", true);
  assert.equal(await page.locator("#description").inputValue(), description.replace(/\r\n/g, "\n"));
  checks.push("Exact filenames; md/txt only; selecting does not apply; Description cancel/apply preserves UTF-8 Markdown");
  const first = page.locator(".reference-card").nth(0), second = page.locator(".reference-card").nth(1);
  await first.locator(".reference-preset").selectOption("ShapeOnly.md");
  await dialogClick(first.locator(".apply-reference-preset"), "현재 Reference Note를 프리셋 내용으로 교체하시겠습니까?", false);
  assert.equal(await first.locator(".reference-note").inputValue(), "First note");
  await dialogClick(first.locator(".apply-reference-preset"), "현재 Reference Note를 프리셋 내용으로 교체하시겠습니까?", true);
  assert.equal(await first.locator(".reference-note").inputValue(), note.replace(/\r\n/g, "\n"));
  assert.equal(await second.locator(".reference-note").inputValue(), "Second note");
  assert.deepEqual(await first.locator(".reference-roles input:checked").evaluateAll((items) => items.map((item) => item.value)), ["Shape"]);
  checks.push("Reference preset updates only selected Note, with confirmation and unchanged Roles");
  const destination = "Z:\\RicochetAngles\\00_Asset\\MODEL";
  await page.locator("#root-path").fill(destination);
  await dialogClick(page.locator("#save-destination"), "Destination preset name", true, "RicochetAngles Models");
  await page.locator("#destination-status").filter({ hasText: "saved on this machine" }).waitFor();
  await page.locator("#root-path").fill(root);
  await page.locator("#destination-preset").selectOption("");
  await page.locator("#destination-preset").selectOption("RicochetAngles Models");
  assert.equal(await page.locator("#root-path").inputValue(), destination);
  const otherPage = await context.newPage();
  await otherPage.goto(url);
  await otherPage.locator("#destination-preset option").filter({ hasText: "RicochetAngles Models" }).waitFor({ state: "attached" });
  assert.equal(JSON.parse(await fs.readFile(settingsPath)).destinationPresets[0].path, destination);
  await otherPage.close();
  checks.push("Destination registration/selection and new-page persistence; nonexistent RicochetAngles path is accepted");
  await page.locator("#root-path").fill(root);
  await dialogClick(page.locator("#save-as-button"), "새로 저장하시겠습니까?", true);
  const bPath = path.join(root, "Browser_B");
  await page.locator("#loaded-job-label").filter({ hasText: bPath }).waitFor();
  assert.deepEqual(await snapshot(a.jobPath), sourceBeforeSaveAs);
  let b = JSON.parse(await fs.readFile(path.join(bPath, "manifest.json")));
  assert.equal(b.job.description, description);
  assert.deepEqual(b.metadata.job_description_preset, { file: descriptionFile, resolved_content: description });
  assert.equal(b.references[0].note, note);
  assert.equal(b.metadata.reference_note_presets[b.references[0].file].resolved_content, note);
  assert.equal(b.metadata.destinationPresets, undefined);
  assert.deepEqual(await fs.readdir(path.join(bPath, "work")), []);
  assert.deepEqual(await fs.readdir(path.join(bPath, "output")), []);
  assert.deepEqual(await fs.readFile(path.join(bPath, "RUN_LOG.md")), await fs.readFile(new URL("../templates/RUN_LOG.template.md", import.meta.url)));
  for (const ref of b.references) assert.deepEqual(await fs.readFile(path.join(bPath, ref.file)), image);
  await page.screenshot({ path: path.join(root, "save-as-presets.png"), fullPage: true });
  checks.push("SAVE AS creates B with exact preset snapshots and independent images, fresh runtime state; A unchanged");
  await page.locator("#description").fill("B edit after Save As");
  await dialogClick(page.locator("#create-button"), "덮어쓰시겠습니까?", true); await saved();
  await dialogClick(page.locator("#create-button"), "덮어쓰시겠습니까?", true); await saved();
  b = JSON.parse(await fs.readFile(path.join(bPath, "manifest.json")));
  assert.equal(b.job.description, "B edit after Save As");
  assert.equal((await fs.readdir(path.join(bPath, "references"))).length, 3);
  assert.deepEqual(await snapshot(a.jobPath), sourceBeforeSaveAs);
  checks.push("New edit context writes only B; repeated save does not duplicate references");
  await fs.writeFile(path.join(presetRoot, "jobDescription", descriptionFile), "Changed preset source");
  await page.locator("#refresh-presets").click();
  assert.equal(await page.locator("#description").inputValue(), "B edit after Save As");
  assert.equal(b.metadata.job_description_preset.resolved_content, description);
  checks.push("Refreshing changed preset files never reapplies them or changes saved snapshots");
  const future = await createJob(job("Future"));
  future.manifest.schema_version = "2.0";
  await fs.writeFile(path.join(future.jobPath, "manifest.json"), JSON.stringify(future.manifest));
  await page.locator("#load-job-path").fill(future.jobPath);
  await page.locator("#load-job-button").click();
  await page.locator("#mode-badge").filter({ hasText: "READ ONLY" }).waitFor();
  assert.equal(await page.locator("#create-button").isDisabled(), true);
  assert.equal(await page.locator("#save-as-button").isDisabled(), true);
  await page.screenshot({ path: path.join(root, "future-readonly.png"), fullPage: true });
  checks.push("Future schema keeps both SAVE CHANGES and SAVE AS disabled");
  assert.deepEqual(errors, []);
  const report = { result: "PASS", browser: await browser.version(), root, checks, consoleErrors: errors };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
