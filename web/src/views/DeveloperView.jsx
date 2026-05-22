import { useMemo, useState } from "react";
import EventTimeline from "../components/EventTimeline.jsx";
import JsonInspector from "../components/JsonInspector.jsx";
import ArtifactList from "../components/ArtifactList.jsx";

const ARTIFACT_ORDER = [
  "state.json",
  "strategic-context.json",
  "clarification.json",
  "research-plan.json",
  "evidence.json",
  "knowledge-map.json",
  "comparison-matrix.json",
  "architecture.spec.json",
  "domain-evaluation-pack.json",
  "critique.json",
  "citation-audit.json",
  "claim-audit.json",
  "execution-handoff.json"
];

export default function DeveloperView({ summary, artifacts, events }) {
  const orderedArtifacts = useMemo(
    () =>
      ARTIFACT_ORDER.filter((name) => artifacts[name]).map((name) => ({
        name,
        data: artifacts[name]
      })),
    [artifacts]
  );

  const [selectedArtifact, setSelectedArtifact] = useState(orderedArtifacts[0]?.name || null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [eventFilter, setEventFilter] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (eventTypeFilter && event.type !== eventTypeFilter) return false;
      if (eventFilter) {
        const haystack = JSON.stringify(event).toLowerCase();
        if (!haystack.includes(eventFilter.toLowerCase())) return false;
      }
      return true;
    });
  }, [events, eventFilter, eventTypeFilter]);

  const eventTypes = useMemo(() => {
    const set = new Set();
    for (const event of events) if (event?.type) set.add(event.type);
    return [...set].sort();
  }, [events]);

  const artifactData =
    selectedArtifact && artifacts[selectedArtifact] ? artifacts[selectedArtifact] : null;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <div className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="card-title">Event stream</h2>
            <div className="flex items-center gap-2 text-xs text-ink-500">
              {events.length} events · live tail
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Search events…"
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              className="flex-1 rounded-md border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs"
            />
            <select
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs"
            >
              <option value="">all types ({events.length})</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 max-h-[55vh] overflow-y-auto rounded-md border border-ink-800">
            <EventTimeline
              events={filteredEvents}
              onSelect={setSelectedEvent}
              selected={selectedEvent}
            />
          </div>
        </div>

        {selectedEvent && (
          <div className="card p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="card-title">Event detail</h2>
              <button
                onClick={() => setSelectedEvent(null)}
                className="text-xs text-ink-500 hover:text-ink-200"
              >
                close
              </button>
            </div>
            <JsonInspector data={selectedEvent} />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="card p-4">
          <h2 className="card-title">Run state</h2>
          {summary?.state && <JsonInspector data={summary.state} />}
        </div>
        <div className="card p-4">
          <h2 className="card-title">Artifacts</h2>
          <ArtifactList
            items={orderedArtifacts}
            selected={selectedArtifact}
            onSelect={setSelectedArtifact}
          />
          {artifactData && (
            <div className="mt-3 max-h-[60vh] overflow-y-auto rounded-md border border-ink-800 bg-ink-950/60 p-3">
              <JsonInspector data={artifactData} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
