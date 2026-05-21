import { readFile } from "node:fs/promises";

const files = [
  "docs/schemas/architecture-spec.schema.json",
  "docs/schemas/domain-evaluation-pack.schema.json",
  "examples/logistics-contract-mesh/architecture.spec.json",
  "examples/logistics-contract-mesh/domain-evaluation-pack.json"
];

for (const file of files) {
  JSON.parse(await readFile(file, "utf8"));
  console.log(`valid json: ${file}`);
}
