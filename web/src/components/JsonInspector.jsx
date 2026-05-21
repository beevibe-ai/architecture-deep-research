import { useState } from "react";

export default function JsonInspector({ data, initiallyOpen = true, depth = 0 }) {
  if (data === null) return <span className="text-ink-500">null</span>;
  if (data === undefined) return <span className="text-ink-500">undefined</span>;
  const type = typeof data;
  if (type === "string") {
    if (data.length > 240) return <CollapsedString value={data} />;
    return <span className="text-success-500">"{data}"</span>;
  }
  if (type === "number") return <span className="text-accent-400">{data}</span>;
  if (type === "boolean") return <span className="text-accent-400">{String(data)}</span>;
  if (Array.isArray(data)) return <ArrayNode data={data} initiallyOpen={initiallyOpen} depth={depth} />;
  if (type === "object") return <ObjectNode data={data} initiallyOpen={initiallyOpen} depth={depth} />;
  return <span className="text-ink-500">{String(data)}</span>;
}

function ArrayNode({ data, initiallyOpen, depth }) {
  const [open, setOpen] = useState(initiallyOpen && depth < 2);
  if (data.length === 0) return <span className="text-ink-500">[]</span>;
  return (
    <div className="font-mono text-xs">
      <button onClick={() => setOpen((v) => !v)} className="text-ink-400 hover:text-ink-200">
        {open ? "[" : `[ ${data.length} … ]`}
      </button>
      {open && (
        <div className="ml-4 border-l border-ink-800 pl-3">
          {data.map((item, idx) => (
            <div key={idx} className="py-0.5">
              <span className="text-ink-500">{idx}:</span>{" "}
              <JsonInspector data={item} initiallyOpen={false} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
      {open && <span className="text-ink-400">]</span>}
    </div>
  );
}

function ObjectNode({ data, initiallyOpen, depth }) {
  const entries = Object.entries(data);
  const [open, setOpen] = useState(initiallyOpen && depth < 2);
  if (entries.length === 0) return <span className="text-ink-500">{`{}`}</span>;
  return (
    <div className="font-mono text-xs">
      <button onClick={() => setOpen((v) => !v)} className="text-ink-400 hover:text-ink-200">
        {open ? "{" : `{ ${entries.length} keys … }`}
      </button>
      {open && (
        <div className="ml-4 border-l border-ink-800 pl-3">
          {entries.map(([key, value]) => (
            <div key={key} className="py-0.5">
              <span className="text-ink-400">"{key}"</span>
              <span className="text-ink-500">: </span>
              <JsonInspector data={value} initiallyOpen={false} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
      {open && <span className="text-ink-400">{`}`}</span>}
    </div>
  );
}

function CollapsedString({ value }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="text-left text-success-500 hover:text-success-600"
    >
      {open ? `"${value}"` : `"${value.slice(0, 220)}…" (${value.length} chars)`}
    </button>
  );
}
