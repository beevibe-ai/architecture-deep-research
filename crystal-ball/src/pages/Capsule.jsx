import { Link, useParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { loadCapsule } from "../lib/store.js";
import { CrystalStage } from "../components/CrystalCover.jsx";
import Timeline from "../components/Timeline.jsx";
import VisitorChat from "../components/VisitorChat.jsx";

export default function CapsuleView() {
  const { id } = useParams();
  const capsule = useMemo(() => loadCapsule(id), [id]);
  const [showTimeline, setShowTimeline] = useState(false);

  if (!capsule) {
    return (
      <div className="cb-shell cb-capsule">
        <CrystalStage />
        <div className="cb-overlay cb-center cb-not-found">
          <h1 className="cb-headline-sm">Not found here.</h1>
          <p className="cb-lede">
            Capsule <code>{id}</code> isn't in this browser. v0 stores capsules
            client-side only.
          </p>
          <Link to="/" className="cb-cta cb-cta-ghost">← back</Link>
        </div>
      </div>
    );
  }

  const m = capsule.metadata;

  return (
    <div className="cb-shell cb-capsule">
      <CrystalStage capsule={capsule} />

      <div className="cb-overlay cb-capsule-overlay">
        <header className="cb-capsule-top">
          <Link to="/" className="cb-wordmark cb-back-link">← crystal ball</Link>
          <div className="cb-stats-strip">
            <span>{m.messageCount} msgs</span>
            <span>{m.toolCallCount} tools</span>
            <span>{m.fileChangeCount} edits</span>
            <span className={`cb-outcome cb-outcome-${m.outcome}`}>{m.outcome}</span>
          </div>
        </header>

        <div className="cb-capsule-main">
          <div className="cb-capsule-title-block">
            <h1 className="cb-capsule-title">{capsule.title}</h1>
            <p className="cb-capsule-summary">{capsule.summary}</p>
            {m.topics?.length > 0 && (
              <div className="cb-topics">
                {m.topics.map((t) => (
                  <span key={t} className="cb-topic">{t}</span>
                ))}
              </div>
            )}
          </div>

          <div className="cb-capsule-chat">
            <VisitorChat capsule={capsule} />
          </div>

          <div className="cb-capsule-timeline-toggle">
            <button
              className="cb-cta cb-cta-ghost cb-cta-sm"
              onClick={() => setShowTimeline((v) => !v)}
            >
              {showTimeline ? "hide timeline" : `show timeline · ${capsule.events.length} events`}
            </button>
          </div>

          {showTimeline && (
            <div className="cb-capsule-timeline">
              <Timeline events={capsule.events} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
