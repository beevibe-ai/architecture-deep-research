import ComparisonMatrix from "../components/ComparisonMatrix.jsx";
import EvidencePanel from "../components/EvidencePanel.jsx";
import PlanCard from "../components/PlanCard.jsx";
import DecisionCard from "../components/DecisionCard.jsx";
import QualityPanel from "../components/QualityPanel.jsx";

export default function OperatorView({ summary, artifacts }) {
  const plan = artifacts["research-plan.json"];
  const context = artifacts["strategic-context.json"];
  const knowledgeMap = artifacts["knowledge-map.json"];
  const matrix = artifacts["comparison-matrix.json"];
  const spec = artifacts["architecture.spec.json"];
  const evidence = artifacts["evidence.json"];
  const critique = artifacts["critique.json"];
  const audit = artifacts["citation-audit.json"];
  const claimAudit = artifacts["claim-audit.json"];

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <DecisionCard spec={spec} summary={summary} critique={critique} audit={audit} />
        {Array.isArray(matrix?.cells) && matrix.cells.length > 0 && (
          <ComparisonMatrix matrix={matrix} />
        )}
        {plan && <PlanCard plan={plan} />}
        {Array.isArray(evidence) && evidence.length > 0 && (
          <EvidencePanel evidence={evidence} knowledgeMap={knowledgeMap} />
        )}
      </div>
      <div className="space-y-5">
        <QualityPanel
          summary={summary}
          critique={critique}
          audit={audit}
          claimAudit={claimAudit}
          matrix={matrix}
        />
        {context && <ContextCard context={context} />}
      </div>
    </div>
  );
}

function ContextCard({ context }) {
  return (
    <div className="card p-4 space-y-3">
      <h2 className="card-title">Strategic context</h2>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-xs text-ink-500">Domain</dt>
          <dd className="font-mono text-ink-200">{context.domain}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">Decision focus</dt>
          <dd className="font-mono text-ink-200">{context.decision}</dd>
        </div>
        {Array.isArray(context.bounded_contexts) && context.bounded_contexts.length > 0 && (
          <div>
            <dt className="text-xs text-ink-500">Bounded contexts</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {context.bounded_contexts.map((bc) => (
                <span key={bc} className="pill">
                  {bc}
                </span>
              ))}
            </dd>
          </div>
        )}
        {Array.isArray(context.query_shapes) && context.query_shapes.length > 0 && (
          <div>
            <dt className="text-xs text-ink-500">Query shapes</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {context.query_shapes.map((shape) => (
                <span key={shape.name} className="pill">
                  {shape.name}
                </span>
              ))}
            </dd>
          </div>
        )}
        {Array.isArray(context.compliance_constraints) && context.compliance_constraints.length > 0 && (
          <div>
            <dt className="text-xs text-ink-500">Compliance constraints</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {context.compliance_constraints.map((c) => (
                <span key={c} className="pill">
                  {c}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
