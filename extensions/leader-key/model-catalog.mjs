import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {import("@mariozechner/pi-agent-core").ThinkingLevel} ThinkingLevel
 * @typedef {import("@mariozechner/pi-ai").Model<any>} Model
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} nickname
 * @property {string} provider
 * @property {string} model
 * @property {ThinkingLevel} thinking
 */

/**
 * @typedef {Object} ModelCatalog
 * @property {string} defaultModel
 * @property {CatalogEntry[]} entries
 * @property {string} setupHint
 */

/**
 * @param {{ agentDir?: string; cwd?: string }} [overrides]
 * @returns {string}
 */
export function catalogPath(overrides) {
  if (overrides?.agentDir) {
    return join(overrides.agentDir, "model-catalog.json");
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, "model-catalog.json");
  }
  return join(homedir(), ".pi", "agent", "model-catalog.json");
}

/**
 * @param {{ agentDir?: string; cwd?: string }} [overrides]
 * @returns {ModelCatalog | null}
 */
export function loadModelCatalog(overrides) {
  const filePath = catalogPath(overrides);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {CatalogEntry} entry
 * @param {Model[]} availableModels
 * @returns {Model | undefined}
 */
export function findRegistryMatch(entry, availableModels) {
  return availableModels.find(
    (model) => model.provider.toLowerCase() === entry.provider.toLowerCase() &&
      model.id.toLowerCase() === entry.model.toLowerCase(),
  );
}

/**
 * @param {ModelCatalog | null} catalog
 * @param {Model[]} availableModels
 * @returns {Array<CatalogEntry & { matched: Model | undefined }>}
 */
export function matchCatalogToRegistry(catalog, availableModels) {
  if (!catalog) return [];
  return catalog.entries.map((entry) => ({
    ...entry,
    matched: findRegistryMatch(entry, availableModels),
  }));
}

/**
 * @param {ModelCatalog | null} catalog
 * @returns {string | undefined}
 */
export function activeDefaultNickname(catalog) {
  return catalog?.defaultModel;
}

/**
 * @param {ModelCatalog | null} catalog
 * @returns {string}
 */
export function buildSetupHint(catalog) {
  return catalog?.setupHint ?? "Add named models to install-config.json under profiles.<profile>.models.";
}
