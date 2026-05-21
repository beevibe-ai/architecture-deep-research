# Beevibe Integration

ADR is designed to run as a Beevibe Architect specialist.

The adapter in `adapters/beevibe.mjs` exposes:

- `createBeevibeArchitectAgentConfig()`
- `createBeevibeMeshHandoff()`
- `writeBeevibeMeshHandoff()`

## Architect Agent

```js
import { createBeevibeArchitectAgentConfig } from "@beevibe/architecture-deep-research/adapters/beevibe";

const architect = createBeevibeArchitectAgentConfig({
  name: "Architect",
  hierarchyLevel: "team",
  reviewPolicy: "require_human"
});
```

The config maps ADR into Beevibe's existing agent primitive:

- `name`
- `hierarchy_level`
- `parent_agent_id`
- `runtime_config`
- `review_policy`

No new Beevibe domain type is required.

## Mesh Handoff

After a live ADR run:

```js
import { createBeevibeMeshHandoff } from "@beevibe/architecture-deep-research/adapters/beevibe";

const handoff = await createBeevibeMeshHandoff({
  outDir: ".adr-runs/logistics-contract-mesh"
});
```

The handoff includes:

- selected topology;
- required invariants;
- forbidden topologies;
- artifact paths;
- evaluation suite name;
- memory facts for the Architect bee;
- mesh instruction for downstream implementation agents.

## Product Boundary

The Beevibe mesh binds ADR to implementation without turning ADR into implementation.

The Architect specialist researches, stamps the architecture spec, and hands down constraints. IC coding agents then execute under those constraints. If implementation evidence contradicts the spec, the next step is a superseding ADR.
