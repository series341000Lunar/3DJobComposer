export const COMPOSER_VERSION = "0.2.1";
export const SCHEMA_VERSION = "1.1";

export const OPTIONS = Object.freeze({
  referenceRoles: [
    "Shape",
    "Proportion",
    "Detail",
    "Material",
    "Mechanism",
    "Style",
    "Topology",
    "Lighting",
    "Composition",
    "Render Style",
    "Other"
  ],
  assetCategories: [
    "Unspecified",
    "Environment",
    "Prop",
    "Vehicle",
    "Architecture",
    "Character",
    "Creature",
    "Mechanical",
    "Other"
  ],
  qualityLevels: [
    "Unspecified",
    "Blockout",
    "Low Poly",
    "Mid Poly",
    "High Poly",
    "Production CG"
  ],
  motionTypes: [
    "Static",
    "Mechanical Motion",
    "Rig Required",
    "Deformation Required"
  ],
  subjectTypes: ["Hard Surface", "Organic", "Human", "Animal"],
  purposes: [
    "Unspecified",
    "CGI",
    "Game Asset",
    "Previz",
    "3D Printing",
    "Mechanical Prototype",
    "Other"
  ],
  dccs: ["Unspecified", "Blender", "3ds Max", "Fusion", "Other"],
  units: ["Unspecified", "mm", "cm", "m"],
  workScopes: [
    "Unspecified",
    "Modeling",
    "Material / LookDev",
    "Lighting",
    "Rigging",
    "Animation",
    "Rendering",
    "Other"
  ],
  outputs: ["BLEND", "MAX", "FBX", "OBJ", "STL", "STEP", "PNG", "EXR", "Other"],
  referencePackageModes: [
    "Part ID",
    "Silhouette",
    "Contour + Panel Lines",
    "Neutral Clay",
    "Neutral Clay + Weak AO",
    "Directional Light — Left",
    "Directional Light — Right",
    "Directional Light — Top",
    "Isolated Part — Orthographic",
    "Isolated Part — Isometric",
    "Three-View + Isometric"
  ],
  referencePackageScopes: ["Whole Asset", "Specific Part"]
});
