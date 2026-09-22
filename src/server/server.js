import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { OPTIONS, COMPOSER_VERSION, SCHEMA_VERSION } from "./constants.js";
import { createJob, JobExistsError, JobLoadError, loadJob, saveJob } from "./job-service.js";
import { ValidationError } from "./job-schema.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const openTokens = new Map();
const editTokens = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 150 * 1024 * 1024) throw Object.assign(new Error("Request is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

async function serveStatic(request, response, url) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(WEB_ROOT, requested);
  if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${path.sep}`)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch (error) {
    json(response, error.code === "ENOENT" ? 404 : 500, { error: "File not found." });
  }
}

async function handleRequest(request, response) {
  const port = request.socket.localPort;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(request.headers.host)) return json(response, 403, { error: "Invalid local Host." });
  if (request.method === "POST") {
    if (!allowedHosts.map((host) => `http://${host}`).includes(request.headers.origin)) {
      return json(response, 403, { error: "A trusted Composer Origin is required." });
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json(response, 415, { error: "Content-Type must be application/json." });
    }
  }
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method === "GET" && url.pathname === "/api/config") {
    json(response, 200, {
      composerVersion: COMPOSER_VERSION,
      schemaVersion: SCHEMA_VERSION,
      runtime: { executable: process.execPath, pid: process.pid },
      options: OPTIONS
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    try {
      const result = await createJob(await readJson(request));
      const openToken = crypto.randomUUID();
      openTokens.set(openToken, result.jobPath);
      json(response, 201, { ...result, manifest: undefined, openToken });
    } catch (error) {
      const status = error instanceof JobExistsError ? 409 : error instanceof ValidationError ? 400 : error.statusCode || 500;
      json(response, status, { error: error.message, field: error.field, recovery: error.recovery });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/load") {
    try {
      const { jobPath } = await readJson(request);
      const result = await loadJob(jobPath);
      const editToken = crypto.randomUUID();
      const openToken = crypto.randomUUID();
      if (!result.readOnly) editTokens.set(editToken, result.jobPath);
      openTokens.set(openToken, result.jobPath);
      json(response, 200, { ...result, editToken: result.readOnly ? null : editToken, openToken });
    } catch (error) {
      const status = error instanceof JobLoadError ? 400 : error instanceof ValidationError ? 400 : error.statusCode || 500;
      json(response, status, { error: error.message, field: error.field, recovery: error.recovery });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/save") {
    try {
      const { editToken, job } = await readJson(request);
      const loadedJobPath = editTokens.get(editToken);
      if (!loadedJobPath) return json(response, 403, { error: "This Job is not loaded for editing. Load it again before saving." });
      const result = await saveJob(loadedJobPath, job);
      const openToken = crypto.randomUUID();
      openTokens.set(openToken, result.jobPath);
      json(response, 200, { ...result, manifest: undefined, openToken });
    } catch (error) {
      const status = error instanceof JobLoadError ? 400 : error instanceof ValidationError ? 400 : error.statusCode || 500;
      json(response, status, { error: error.message, field: error.field, recovery: error.recovery });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/open-folder") {
    try {
      const { token } = await readJson(request);
      const folderPath = openTokens.get(token);
      if (!folderPath) return json(response, 404, { error: "This folder link is no longer available." });
      const explorer = spawn("explorer.exe", [folderPath], { detached: true, stdio: "ignore", windowsHide: true });
      explorer.unref();
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response, url);
    return;
  }

  json(response, 405, { error: "Method not allowed." });
}

export const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => json(response, 500, { error: error.message }));
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`3DJobComposer v${COMPOSER_VERSION} running at http://${HOST}:${PORT}`);
    console.log(`Node runtime: ${process.execPath}`);
  });
}
