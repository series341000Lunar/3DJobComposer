# 3DJobComposer

For cross-account or maintainer transfer, read [`DESIGN_HANDOFF.md`](DESIGN_HANDOFF.md) before changing the implementation.

3DJobComposer is a lightweight, Windows-first, optional interface that packages a human-authored 3D brief and provided references into a standardized Job Package. It does not perform modeling, technical research, reference analysis, or production judgment. Those responsibilities remain with 3dAI or the production worker.

Natural-language freedom is a core contract. A description such as “Create a QNAP TS-1655; find official material or three-view references if needed” is a valid request by itself. Structured fields exist only for facts or constraints the user already knows or explicitly wants to control; unspecified and empty selections are valid. Using Composer is not a prerequisite for a normal 3dAI workflow—it is a convenience for repeatability, reference management, condition tracking, and comparing execution results.

## Requirements

- Windows 10 or later
- Node.js 20 or later
- No npm packages are required

## Run

On Windows, double-click `start-3DJobComposer.bat`. It uses the standalone Node.js installation under `Program Files`, opens the local server in a dedicated console, and then opens the application in the default browser. The launcher intentionally avoids Codex's internal Node.js runtime because that runtime can be restricted to the Codex workspace. Close the server console or press `Ctrl+C` in it to stop the application.

Alternatively, run it manually from PowerShell in the project directory:

```powershell
node src/server/server.js
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173) in a browser. The server listens only on the local loopback interface by default.

If `npm` is available, `npm start` runs the same command. For development with automatic server restart, use `npm run dev`.

Optional environment variables:

```powershell
$env:PORT = "5000"
node src/server/server.js
```

## Create a new Job

1. Enter a Job Name and the original Job Description.
2. Add zero or more reference images by selecting or dragging files. Set Roles and a Note for each image. Cards remain in insertion order; remove and re-add an image to change its position in V1.
3. Optionally choose asset, motion, subject, Work Scope, purpose, DCC, unit, and Deliverables. Leave unknown production decisions unspecified.
4. Optionally enable **AI Reference Package** and add the ImageGen reference requests that should be prepared later.
5. Enter an absolute Job Root path. The most recently submitted root is remembered in browser local storage.
6. Select **CREATE JOB**. On success, use **OPEN JOB FOLDER** to open the result in Windows Explorer.

Unsafe Windows filename characters, whitespace, trailing dots, and reserved device names in the Job Name are sanitized. Existing job folders are never overwritten.

## Load and save an existing Job

Enter the existing Job folder path at the top of the page and select **LOAD JOB**. `manifest.json` is the canonical source; `TASK.md` is never parsed to reconstruct data. A loaded Job enters **Editing Existing Job** mode, displays its path, restores available reference previews, and reports missing files or unsupported values as warnings.

- **CREATE JOB** is available in New Job mode and never overwrites an existing folder.
- **SAVE CHANGES** is available only after an explicit successful load. The server issues an in-memory edit token for that exact folder, so an arbitrary folder cannot be overwritten through the save endpoint.
- SAVE updates `manifest.json` and regenerates `TASK.md`. It adds newly selected reference files and reflects current UI order, roles, and notes.
- `RUN_LOG.md` is never reset or overwritten by SAVE. Older Jobs without it receive a new empty template on their first save.
- Removing a loaded Reference excludes it from the new manifest and TASK, but deliberately leaves its existing file on disk. This conservative V1.1 policy avoids accidental source-image loss.
- Missing Reference files are retained as warned manifest entries unless the user removes them from the UI.
- **START NEW JOB** clears edit authorization and returns to overwrite-protected New Job mode.

Edit tokens live only for the current server process. Restarting the server requires loading the Job again before SAVE.

## AI Reference Package planning

The AI Reference Package section records which modeling-support images a later ImageGen/3dAI workflow should create. Each item stores enabled state, Mode, Whole Asset or Specific Part scope, Source References, optional Target Part, and the user's original Notes. Supported modes include Part ID, silhouette/clay/lighting studies, isolated-part views, and **Three-View + Isometric**.

This version is an authoring tool only: it does not invoke ImageGen, analyze images, or generate the planned reference package.

## Development and tests

The application intentionally uses only Node.js built-ins and browser APIs, so no `npm install` step is required after Node.js itself is installed.

```powershell
node --test
```

The server/backend is separated into validation and manifest construction (`job-schema.js`), package creation (`job-service.js`), Markdown rendering (`task-renderer.js`), and HTTP/static serving (`server.js`). UI option values are loaded from the backend's versioned constants rather than duplicated in the form markup.

## Generated Job Package

```text
<JobRoot>/
└─ <sanitized-job-name>/
   ├─ TASK.md
   ├─ manifest.json
   ├─ RUN_LOG.md
   ├─ references/
   │  ├─ ref_001.png
   │  └─ ref_002.jpg
   ├─ work/
   └─ output/
```

- `manifest.json` is the machine-readable, versioned canonical source. Schema 1.1 records `work_scope`, `deliverables`, expanded Reference roles, and `reference_package` alongside the preserved brief and relative reference paths.
- `TASK.md` is a readable, structured handoff for Codex or a human artist. The description and reference notes are included without summarization or rewriting.
- `RUN_LOG.md` is an initially empty execution-history template for the actual 3D production worker. Composer never invents results and never overwrites existing run history.
- `references/` contains byte-for-byte copies of uploaded files, renamed sequentially to avoid collisions. No image is resized, converted, or recompressed.
- `work/` is reserved for in-progress production files.
- `output/` is reserved for requested deliverables.

Package creation is staged in a temporary sibling folder and renamed only after all files are written. This prevents an incomplete final package from being left behind if creation fails.

## V1.1 / V1.2 features

- Job name sanitization and original description preservation
- Multiple image selection and drag-and-drop
- Image previews, per-reference removal, ordering, multi-role selection, and notes
- Asset category, quality, motion, subject, purpose, DCC, unit, Work Scope, and Deliverables
- `Unspecified` support for Quality, Purpose, DCC, and Work Scope
- PNG and EXR Deliverables and Lighting, Composition, and Render Style Reference roles
- Existing Job load, preview restoration, missing-file warnings, and authorized overwrite save
- Empty RUN_LOG template creation and preservation of existing execution history
- AI Reference Package plan authoring with multiple items and Three-View + Isometric mode
- Direct Job Root path entry with local persistence
- Versioned JSON manifest and generated Markdown task
- Safe duplicate-job rejection
- Windows Explorer **OPEN JOB FOLDER** action
- Responsive desktop-focused UI

## Backward compatibility

Schema 1.0 manifests without `work_scope`, `deliverables`, or `reference_package` can be loaded. Legacy `target.outputs` is mapped to Deliverables; missing Work Scope becomes `Unspecified`; and AI Reference Package defaults to disabled. Unknown future values produce warnings and compatible fields are restored where possible.

## Not supported

- Launching Codex, Blender, 3ds Max, or Fusion
- Actual ImageGen execution, AI image analysis, automatic classification, or annotation
- Modeling, technical investigation, automatic reference research, or production decisions
- Job history/database, accounts, cloud features, or direct 3dAI execution
- Complex quality/purpose presets
- Native folder picker
- Drag-to-reorder reference cards

## Future improvements

Likely next steps are a native folder picker, explicit drag-to-reorder controls, schema migration/validation tooling, package-item presets, and a separate ImageGen/Codex/3dAI execution layer that consumes the authored plan.

## Phase 1 save and recovery contract

- **NEW JOB / CREATE JOB** refuses an existing destination. **LOAD JOB / SAVE CHANGES** updates only the exact folder authorized by its server-side edit token.
- After a successful save, the UI adopts the returned reference paths. Another unchanged save reuses those files. Removing an existing reference still leaves its source file on disk.
- No-op saves preserve `job.original_name`, explicit empty lists, and unchanged absent/null values and extension metadata. Schema 1.0 still follows the supported migration to 1.1.
- Unsupported schemas (including future versions) open for inspection where possible, with a warning and disabled save. The server does not grant an edit token and rechecks the on-disk schema before saving.
- The server binds to `127.0.0.1`. All requests require a local Host with the actual server port. All POST endpoints require `Origin: http://127.0.0.1:<port>` or `http://localhost:<port>`, and `Content-Type: application/json`. Missing/null/external origins are rejected before reading the body or changing files. Local scripts must send these headers; this is a browser-origin boundary, not account authentication.

SAVE stages and verifies all new contents and records the previous document bytes and checksums in `<Job>/.composer-save-recovery/journal.json` before changing final files. It commits manifest, TASK, new references, and a missing RUN_LOG template as one recoverable operation. Existing RUN_LOG and existing reference files are never overwritten. On a caught failure it restores and verifies the previous state, removes only this transaction's additions, and returns `recovery.state = rolled_back`.

If rollback cannot finish, the response includes `recovery_required` and the recovery path. Further saves are blocked; LOAD shows a recovery warning (or an explicit recovery error if the manifest is unreadable). Do not delete the recovery folder. Stop Composer and other writers, then run from the project directory:

```powershell
node src/server/recover-save.js "<absolute affected Job folder>"
```

The recovery command verifies backups and restores the previous state. If all final writes were verified and the COMMITTED marker exists, it instead verifies the new state and finishes cleanup. A successful save whose cleanup failed returns `committed_cleanup_required`; the UI clearly reports that the data was saved and disables further saves until recovery cleanup. Reload after restarting Composer. If recovery reports an error, retain the folder and backups for inspection.

This is a recoverable multi-file save, not a filesystem-wide atomic transaction. Process interruption is regression-tested. Power loss/NAS hardware durability and concurrent external writers are not guaranteed; full stale-edit conflict detection remains F07.

### Phase 1 verification

`node --test` runs the original 9 tests plus 21 Phase 1 regressions. New fixtures are isolated under ignored `.tmp/phase1-*`; actual user Jobs are never test fixtures.

Optional real-browser smoke (Microsoft Edge installed; Playwright is a development-only tool):
```powershell
$browserTools = Join-Path $env:TEMP "3djc-phase1-browser-tools"
npm install --prefix $browserTools --no-audit --no-fund playwright
$env:PLAYWRIGHT_MODULE = Join-Path $browserTools "node_modules/playwright/index.mjs"
node tools/browser-phase1.mjs
```

The smoke creates only synthetic Jobs in `.tmp/browser-phase1-*`, verifies create/load/edit/save/reload, repeated reference save, and future-schema read-only behavior, and records screenshots plus `result.json`. The known unrelated `favicon.ico` 404 is recorded separately from application JavaScript errors; it is not silently suppressed.
