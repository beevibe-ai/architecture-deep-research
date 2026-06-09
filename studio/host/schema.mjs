// JSON Schema for architecture.spec.json, validated on read so a corrupt or
// hand-edited file surfaces a clear warning instead of silently breaking the
// canvas. Permissive on purpose (additionalProperties allowed) — the IR evolves,
// and research-produced specs carry extra fields we pass through untouched.
import Ajv from "ajv";

export const SPEC_SCHEMA = {
  // No $schema — the bundled Ajv is draft-07 and this schema uses no 2020 features.
  type: "object",
  required: ["version", "views"],
  properties: {
    version: { type: "string" },
    decision: { type: "object" },
    domain_model: { type: "object" },
    guardrails: { type: "object" },
    views: {
      type: "object",
      required: ["architecture", "data_model", "flows"],
      properties: {
        architecture: {
          type: "object",
          required: ["nodes", "edges"],
          properties: { nodes: { type: "array" }, edges: { type: "array" } },
        },
        data_model: {
          type: "object",
          required: ["entities", "relations"],
          properties: { entities: { type: "array" }, relations: { type: "array" } },
        },
        flows: { type: "array" },
      },
    },
    constraints: { type: "array" },
    cross_refs: { type: "array" },
    plan: { type: "object" },
  },
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validator = ajv.compile(SPEC_SCHEMA);

// Returns { ok, errors } — errors is a short human-readable list.
export function validateSpec(spec) {
  const ok = validator(spec);
  const errors = ok ? [] : (validator.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  return { ok, errors };
}
