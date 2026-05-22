export default function ArtifactList({ items, selected, onSelect }) {
  return (
    <ul className="space-y-1" role="list">
      {items.map((item) => {
        const isSelected = item.name === selected;
        return (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => onSelect?.(item.name)}
              aria-current={isSelected ? "true" : undefined}
              aria-pressed={isSelected}
              className={`w-full rounded-md px-2 py-1 text-left font-mono text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                isSelected
                  ? "bg-accent-500/15 text-accent-400"
                  : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
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
