export default function ArtifactList({ items, selected, onSelect }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const isSelected = item.name === selected;
        return (
          <li key={item.name}>
            <button
              onClick={() => onSelect?.(item.name)}
              className={`w-full rounded-md px-2 py-1 text-left font-mono text-xs ${
                isSelected
                  ? "bg-accent-500/15 text-accent-400"
                  : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
              }`}
            >
              {item.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
