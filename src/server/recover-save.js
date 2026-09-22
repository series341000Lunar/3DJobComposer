import { recoverSave } from "./save-transaction.js";
import path from "node:path";
const jobPath = process.argv[2];
if (!jobPath || !path.isAbsolute(jobPath)) {
  console.error('Stop Composer, then run: node src/server/recover-save.js "<absolute synthetic or affected Job folder>"');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await recoverSave(jobPath), null, 2)); }
  catch (error) { console.error("Recovery not completed; retain recovery data:", error.message); process.exitCode = 1; }
}
