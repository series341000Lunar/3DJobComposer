// Optional browser regression: set PLAYWRIGHT_MODULE to an installed playwright/index.mjs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { server } from "../src/server/server.js";
import { createJob } from "../src/server/job-service.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
await fs.mkdir(temp, { recursive: true });
const root = await fs.mkdtemp(path.join(temp, "browser-phase1-"));
const errors = [], warnings = [];
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ text: message.text(), location: message.location() });
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#version").filter({ hasText: "schema 1.1" }).waitFor();
  assert.equal(await page.locator("#mode-badge").innerText(), "NEW JOB");
  await page.locator("#job-name").fill("Browser Synthetic");
  await page.locator("#description").fill("Original browser description");
  await page.locator("#root-path").fill(root);
  await page.getByRole("button", { name: "CREATE JOB", exact: true }).click();
  await page.locator("#status").filter({ hasText: "created successfully" }).waitFor();
  const jobPath = path.join(root, "Browser_Synthetic");
  await page.locator("#load-job-path").fill(jobPath);
  await page.getByRole("button", { name: "LOAD JOB", exact: true }).click();
  await page.locator("#mode-title").filter({ hasText: "Editing Existing Job" }).waitFor();
  assert.match(await page.locator("#loaded-job-label").innerText(), /Browser_Synthetic/);
  await page.locator("#description").fill("Edited browser description");
  await page.getByRole("button", { name: "SAVE CHANGES", exact: true }).click();
  await page.locator("#status").filter({ hasText: "saved successfully" }).waitFor();
  await page.reload();
  await page.locator("#version").filter({ hasText: "schema 1.1" }).waitFor();
  await page.locator("#load-job-path").fill(jobPath);
  await page.getByRole("button", { name: "LOAD JOB", exact: true }).click();
  await page.locator("#mode-title").filter({ hasText: "Editing Existing Job" }).waitFor();
  assert.equal(await page.locator("#description").inputValue(), "Edited browser description");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64");
  await page.locator("#reference-input").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: image });
  await page.locator(".reference-card").waitFor();
  await page.getByRole("button", { name: "SAVE CHANGES", exact: true }).click();
  await page.locator("#status").filter({ hasText: "saved successfully" }).waitFor();
  const first = JSON.parse(await fs.readFile(path.join(jobPath, "manifest.json")));
  const files = await fs.readdir(path.join(jobPath, "references"));
  await page.getByRole("button", { name: "SAVE CHANGES", exact: true }).click();
  await page.locator("#status").filter({ hasText: "saved successfully" }).waitFor();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(jobPath, "manifest.json"))).references, first.references);
  assert.deepEqual(await fs.readdir(path.join(jobPath, "references")), files);
  assert.equal(files.length, 1);
  await page.screenshot({ path: path.join(root, "editing.png"), fullPage: true });
  const future = await createJob({
    rootPath: root, jobName: "Future_Synthetic", description: "Future schema inspection",
    asset: { category: "Unspecified", quality: "Unspecified", motion: [], subject: [] },
    target: { purpose: "Unspecified", dcc: "Unspecified", unit: "Unspecified" },
    workScope: [], deliverables: [], references: []
  });
  future.manifest.schema_version = "2.0";
  future.manifest.custom_future_field = { must: "survive" };
  const futureBytes = JSON.stringify(future.manifest, null, 2);
  await fs.writeFile(path.join(future.jobPath, "manifest.json"), futureBytes);
  await page.locator("#load-job-path").fill(future.jobPath);
  await page.getByRole("button", { name: "LOAD JOB", exact: true }).click();
  await page.locator("#mode-badge").filter({ hasText: "READ ONLY" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "SAVE CHANGES", exact: true }).isDisabled(), true);
  assert.match(await page.locator("#load-warnings").innerText(), /2.0.*saving is disabled/);
  assert.equal(await fs.readFile(path.join(future.jobPath, "manifest.json"), "utf8"), futureBytes);
  await page.screenshot({ path: path.join(root, "future-readonly.png"), fullPage: true });
  const unrelatedConsoleErrors = errors.filter((error) => error.location?.url?.endsWith("/favicon.ico"));
  const applicationErrors = errors.filter((error) => !unrelatedConsoleErrors.includes(error));
  assert.deepEqual(applicationErrors, []);
  const report = { result: "PASS", browser: await browser.version(), root,
    checks: ["NEW create", "LOAD visible editing mode", "edit/save/reload", "reference repeated save", "future read-only"], errors, warnings, applicationErrors, unrelatedConsoleErrors };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
