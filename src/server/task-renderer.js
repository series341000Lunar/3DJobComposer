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
