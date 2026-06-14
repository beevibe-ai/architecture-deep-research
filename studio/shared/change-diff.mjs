const VIEW_CONFIGS = [
  {
    view: "architecture",
    title: "Architecture",
    root: (spec) => spec?.views?.architecture || {},
    collections: [
      { name: "nodes", bucket: "nodes", item: "component", label: nodeLabel, key: nodeKey, canonical: canonicalNode },
      { name: "edges", bucket: "edges", item: "edge", label: edgeLabel, key: edgeKey, canonical: canonicalEdge },
    ],
  },
  {
    view: "data_model",
    title: "Data model",
    root: (spec) => spec?.views?.data_model || {},
    collections: [
      { name: "entities", bucket: "nodes", item: "entity", label: entityLabel, key: entityKey, canonical: canonicalNode },
      { name: "relations", bucket: "edges", item: "relation", label: relationLabel, key: relationKey, canonical: canonicalEdge },
    ],
  },
  {
    view: "infra",
    title: "Infrastructure",
    root: (spec) => spec?.views?.infra || {},
    collections: [
      { name: "nodes", bucket: "nodes", item: "infra node", label: nodeLabel, key: nodeKey, canonical: canonicalNode },
      { name: "edges", bucket: "edges", item: "infra edge", label: edgeLabel, key: edgeKey, canonical: canonicalEdge },
    ],
  },
  {
    view: "classes",
    title: "Class",
    root: (spec) => spec?.views?.classes || {},
    collections: [
      { name: "nodes", bucket: "nodes", item: "class", label: classLabel, key: classKey, canonical: canonicalNode },
      { name: "edges", bucket: "edges", item: "class edge", label: edgeLabel, key: edgeKey, canonical: canonicalEdge },
    ],
  },
  {
    view: "flows",
    title: "Flows",
    root: (spec) => ({ flows: spec?.views?.flows || [] }),
    collections: [
      { name: "flows", bucket: "nodes", item: "flow", label: flowLabel, key: flowKey, canonical: canonicalNode },
    ],
  },
  {
    view: "sequences",
    title: "Sequence",
    root: (spec) => ({ sequences: spec?.views?.sequences || [] }),
    collections: [
      { name: "sequences", bucket: "nodes", item: "sequence", label: flowLabel, key: flowKey, canonical: canonicalNode },
    ],
  },
];

export function summarizeSpecChange(beforeSpec, afterSpec, source = "Canvas edit") {
  const result = {
    source,
    total: 0,
    added: 0,
    removed: 0,
    updated: 0,
    items: [],
    byView: {},
  };

  for (const viewConfig of VIEW_CONFIGS) {
    const beforeRoot = viewConfig.root(beforeSpec);
    const afterRoot = viewConfig.root(afterSpec);
    const context = buildContext(beforeRoot, afterRoot);
    for (const collection of viewConfig.collections) {
      diffCollection(result, viewConfig, collection, beforeRoot?.[collection.name] || [], afterRoot?.[collection.name] || [], context);
    }
  }

  result.items.sort((a, b) => {
    const rank = { added: 0, updated: 1, removed: 2 };
    return (rank[a.change] ?? 9) - (rank[b.change] ?? 9) || a.view.localeCompare(b.view) || a.label.localeCompare(b.label);
  });

  return result;
}

function diffCollection(result, viewConfig, collection, beforeItems, afterItems, context) {
  const pairs = pairItems(beforeItems, afterItems, (item, side) => collection.key(item, context, side));
  for (const added of pairs.added) {
    pushChange(result, viewConfig, collection, context, "added", null, added);
  }
  for (const removed of pairs.removed) {
    pushChange(result, viewConfig, collection, context, "removed", removed, null);
  }
  for (const [before, after] of pairs.matched) {
    const beforeCanon = stableStringify(collection.canonical(before, context, "before"));
    const afterCanon = stableStringify(collection.canonical(after, context, "after"));
    if (beforeCanon !== afterCanon) pushChange(result, viewConfig, collection, context, "updated", before, after);
  }
}

function pushChange(result, viewConfig, collection, context, change, beforeItem, afterItem) {
  result.total += 1;
  result[change] += 1;
  const item = afterItem || beforeItem;
  const id = afterItem?.id || beforeItem?.id || "";
  const label = collection.label(item, context, change, beforeItem, afterItem);
  result.items.push({
    view: viewConfig.view,
    viewTitle: viewConfig.title,
    collection: collection.name,
    bucket: collection.bucket,
    kind: collection.item,
    change,
    id,
    label: `${viewConfig.title}: ${label}`,
  });

  if (afterItem?.id && change !== "removed") {
    result.byView[viewConfig.view] ||= { nodes: {}, edges: {} };
    result.byView[viewConfig.view][collection.bucket] ||= {};
    result.byView[viewConfig.view][collection.bucket][afterItem.id] = change;
  }
}

function pairItems(beforeItems, afterItems, keyFn) {
  const beforeById = new Map(beforeItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const afterById = new Map(afterItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const usedBefore = new Set();
  const usedAfter = new Set();
  const matched = [];

  for (const after of afterItems) {
    if (!after?.id || !beforeById.has(after.id)) continue;
    const before = beforeById.get(after.id);
    matched.push([before, after]);
    usedBefore.add(before);
    usedAfter.add(after);
  }

  const beforeByKey = groupRemaining(beforeItems, usedBefore, (item) => keyFn(item, "before"));
  const afterByKey = groupRemaining(afterItems, usedAfter, (item) => keyFn(item, "after"));
  for (const [key, afterGroup] of afterByKey) {
    const beforeGroup = beforeByKey.get(key) || [];
    if (!key || beforeGroup.length !== 1 || afterGroup.length !== 1) continue;
    matched.push([beforeGroup[0], afterGroup[0]]);
    usedBefore.add(beforeGroup[0]);
    usedAfter.add(afterGroup[0]);
  }

  return {
    matched,
    added: afterItems.filter((item) => !usedAfter.has(item)),
    removed: beforeItems.filter((item) => !usedBefore.has(item)),
  };
}

function groupRemaining(items, used, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    if (used.has(item)) continue;
    const key = keyFn(item);
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
}

function buildContext(beforeRoot, afterRoot) {
  return {
    beforeNodes: nodeLookup(beforeRoot),
    afterNodes: nodeLookup(afterRoot),
  };
}

function nodeLookup(root) {
  const items = [
    ...(root?.nodes || []),
    ...(root?.entities || []),
    ...(root?.classes || []),
  ];
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function canonicalNode(item, context, side) {
  return stripLayout(normalizeRefs(stripIds(item), context, side));
}

function canonicalEdge(item, context, side) {
  return stripLayout(normalizeRefs(stripIds(item), context, side));
}

function normalizeRefs(value, context, side) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalizeRefs(item, context, side));
  const nodes = side === "before" ? context.beforeNodes : context.afterNodes;
  const next = {};
  for (const [key, val] of Object.entries(value)) {
    if (["from", "to", "parent"].includes(key) && typeof val === "string") {
      next[key] = nodeKey(nodes.get(val) || { id: val }, context, side);
    } else {
      next[key] = normalizeRefs(val, context, side);
    }
  }
  return next;
}

function stripIds(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripIds);
  const next = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === "id") continue;
    next[key] = stripIds(val);
  }
  return next;
}

function stripLayout(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripLayout);
  const next = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === "position" || key === "size") continue;
    next[key] = stripLayout(val);
  }
  return next;
}

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function nodeLabel(item) {
  return `${item?.label || item?.name || item?.type || item?.kind || "component"}`;
}

function entityLabel(item) {
  return `${item?.name || item?.label || "entity"}`;
}

function classLabel(item) {
  return `${item?.name || item?.label || "class"}`;
}

function flowLabel(item) {
  return `${item?.name || item?.label || "flow"}`;
}

function edgeLabel(item, context, change, beforeItem, afterItem) {
  const edge = afterItem || beforeItem || item;
  const nodes = afterItem ? context.afterNodes : context.beforeNodes;
  const from = nodeLabel(nodes.get(edge?.from) || { label: edge?.from || "?" });
  const to = nodeLabel(nodes.get(edge?.to) || { label: edge?.to || "?" });
  return `${from} -> ${to}`;
}

function relationLabel(item, context, change, beforeItem, afterItem) {
  return edgeLabel(item, context, change, beforeItem, afterItem);
}

function nodeKey(item) {
  return [normalize(item?.label || item?.name || item?.id), normalize(item?.type || item?.kind || item?.category || "")].join("|");
}

function entityKey(item) {
  return [normalize(item?.name || item?.label || item?.id), "entity"].join("|");
}

function classKey(item) {
  return [normalize(item?.name || item?.label || item?.id), "class"].join("|");
}

function flowKey(item) {
  return [normalize(item?.name || item?.label || item?.id), "flow"].join("|");
}

function edgeKey(item, context, side) {
  const nodes = side === "before" ? context.beforeNodes : context.afterNodes;
  return [endpointKey(item?.from, nodes), endpointKey(item?.to, nodes)].join("->");
}

function relationKey(item, context, side) {
  return edgeKey(item, context, side);
}

function endpointKey(id, nodes) {
  return nodeKey(nodes.get(id) || { id });
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
