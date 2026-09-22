function renderList(values, indent = "") {
  return values.length ? values.map((value) => `${indent}- ${value}`).join("\n") : `${indent}- None`;
}

export function renderTask(job, references) {
  const sections = [
    "# TASK", "", "## Objective", "", job.description, "",
    "## Asset Specification", "",
    `- Category: ${job.asset.category}`,
    `- Quality: ${job.asset.quality}`,
    "- Motion:", renderList(job.asset.motion, "  "),
    "- Subject:", renderList(job.asset.subject, "  "), "",
    "## Target", "",
    `- Purpose: ${job.target.purpose}`,
    `- DCC: ${job.target.dcc}`,
    `- Unit: ${job.target.unit}`, "",
    "## Work Scope", "", renderList(job.workScope), "",
    "## Deliverables", "", renderList(job.deliverables), "",
    "## References", ""
  ];

  if (references.length === 0) {
    sections.push("No reference images were provided.", "");
  } else {
    references.forEach((reference, index) => {
      sections.push(
        `### REF-${String(index + 1).padStart(3, "0")}`, "",
        "File:", "", `\`${reference.relativePath}\``, "",
        "Roles:", "", renderList(reference.roles), "",
        "Notes:", "", reference.note, ""
      );
    });
  }


  const workflow = job.referenceWorkflow || { mode: "direct" };
  sections.push("## Reference Workflow", "");
  if (workflow.mode === "generate_master_reference") {
    sections.push(
      "Mode: Generate Master Reference First", "",
      "Master Reference generation is requested; no generated Master Reference is included in this package.",
      "Before primary modeling, the execution Agent should create a Master Reference using the Job Description, optional Source References, their Roles/Notes, and the effective instruction below.",
      "Composer packages this request only. It does not call GPT Image or generate images.",
      "Retain Source References for later verification and detail checks; a Master Reference does not replace or delete them.", "",
      "### Master Reference Generation Instruction", "",
      workflow.generate_master_reference.effective_instruction, "",
      "### AI Reference Package Instruction", "",
      workflow.ai_reference_package.effective_instruction || "No additional usage instruction was supplied.", "",
      "### Source References", "", renderList(workflow.source_reference_ids), "",
      "### Requested Working Output", "", "`work/AIReferencePackage/`", "",
      "This is a requested future output location, not an existing Master Reference file.", ""
    );
  } else {
    sections.push("Mode: Direct Reference", "",
      "Use the supplied References directly according to their Roles and Notes.", "");
  }

  sections.push("## AI Reference Package", "");
  if (!job.referencePackage.enabled) {
    sections.push("Disabled.", "");
  } else if (job.referencePackage.items.length === 0) {
    sections.push("Enabled, with no package items specified.", "");
  } else {
    job.referencePackage.items.forEach((item, index) => {
      sections.push(
        `### RP-${String(index + 1).padStart(3, "0")}`, "",
        `Enabled: ${item.enabled ? "Yes" : "No"}`, "",
        "Mode:", "", item.mode, "",
        "Scope:", "", item.scope, "",
        "Source References:", "", renderList(item.sourceReferences), "",
        "Target Part:", "", item.targetPart || "None", "",
        "Notes:", "", item.note, ""
      );
    });
  }

  return `${sections.join("\n").trimEnd()}\n`;
}
