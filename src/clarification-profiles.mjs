// Pre-built answer profiles for the clarification gate.
//
// Real users (especially solo founders) don't want to answer six free-form
// questions about latency / scale / cost / compliance / region / team size.
// They want to pick the profile that matches their stage and let ADR fill
// in sensible defaults. Free-form stays as an option — these are just
// shortcuts when the profile fits.
//
// Each profile carries a structured answer block + a 1-line description.
// When the user picks a profile, ADR appends the profile's answers to the
// PRD content before strategic-context extraction (same code path as
// --clarification-answers).
//
// Match hints look at discover-derived signals to suggest 1-2 profiles:
//   - codebase_age_days: very young (< 30d) → pre-PMF defaults
//   - team_size_hint: solo / 1-3 → pre-PMF defaults; 3-10 → first-customers;
//     10+ → scaling-team
//   - deploy_target.platform: docker-compose / fly.io → small-scale-self-hosted;
//     vercel / railway → managed-platform
//   - compliance_signals presence: triggers enterprise / regulated profiles

const PROFILES = [
  {
    id: "pre_pmf_solo",
    label: "Pre-PMF / solo founder",
    description:
      "Pre-product-market-fit. Solo or 1-3 engineers. Optimizing for time-to-first-customer, not scale. Self-hosted on a single VM or Docker Compose. Budget under $50/mo.",
    answers: {
      latency: "No hard SLA. p95 under 1s is fine. Performance is not the bottleneck pre-PMF.",
      scale: "Under 10 tenants in year 1. Under 100k rows / vectors per tenant.",
      cost: "Budget under $50/mo for this layer. Free tier preferred if available.",
      compliance: "No formal compliance requirements yet. Reasonable security hygiene only.",
      deploy: "Self-hosted, single instance, Docker Compose or a single VM.",
      team_size: "1-3 engineers. Time-to-ship dominates every other concern.",
      lifecycle: "Pre-PMF iteration speed matters more than long-term scale-out cost."
    }
  },
  {
    id: "first_paying_customers",
    label: "First paying customers",
    description:
      "Post-PMF, early revenue. Small team (3-10). Some customers paying, want SOC2 in 12 months. Managed platform deploy (Railway / Fly / Vercel). Budget $50-500/mo per tenant.",
    answers: {
      latency: "p95 under 500ms for user-facing queries. Background work has no SLA.",
      scale: "10-100 tenants. 100k-1M rows / vectors per tenant. Growing 3-5× this year.",
      cost: "Budget $50-500/mo per tenant. Predictable per-tenant unit economics required.",
      compliance: "No formal compliance today; SOC2 Type I planned in 12 months.",
      deploy: "Managed cloud platform (Railway, Fly.io, Vercel) or single-region cloud.",
      team_size: "3-10 engineers. Some ops capacity but not dedicated infra team.",
      lifecycle: "Building durable infrastructure; will not rewrite this layer in 18 months."
    }
  },
  {
    id: "scaling_team_post_seed",
    label: "Scaling team / post-seed",
    description:
      "Funded round, 10-30 engineers. Multiple customers across regions. SOC2 + GDPR required. Multi-region cloud. Budget $500-5000/mo per tenant. p95 latency matters.",
    answers: {
      latency: "p95 under 200ms for user-facing queries. p99 under 500ms.",
      scale: "100+ tenants. 1M+ rows / vectors per tenant. Multi-region read traffic.",
      cost: "Budget $500-5000/mo per tenant. Margins matter.",
      compliance: "SOC2 Type II required. GDPR compliant. EU data residency for EU tenants.",
      deploy: "Multi-region managed cloud or Kubernetes. Dedicated infra team handles deploys.",
      team_size: "10-30 engineers. Dedicated ops / SRE capacity.",
      lifecycle: "Building for the next 3-5 years of growth. Migration cost is a real factor."
    }
  },
  {
    id: "enterprise_regulated",
    label: "Enterprise / regulated industry",
    description:
      "Healthcare, finance, gov, or large enterprise. HIPAA / FedRAMP / SOC2 / GDPR. Self-host option required. Air-gapped or on-prem deploy. Strict latency SLAs.",
    answers: {
      latency: "p99 under 100ms for user-facing queries. Strict SLAs in customer contracts.",
      scale: "1000s of tenants or single-tenant deployments. Multi-region. High availability required.",
      cost: "Cost less important than control. Per-tenant cost dominated by compliance / audit overhead.",
      compliance: "HIPAA + SOC2 Type II + GDPR + possibly FedRAMP. Right-to-deletion. Audit logs.",
      deploy: "Self-hosted option mandatory. On-prem or air-gapped deployments for some customers.",
      team_size: "30+ engineers. Dedicated security / compliance / ops teams.",
      lifecycle: "10+ year horizon. Vendor lock-in is a board-level concern."
    }
  }
];

// Suggest 1-3 profiles that match the discover signals. Returns ranked
// profile IDs (best match first). Empty array if no signals are
// confident — the user gets free-form questions.
function suggestProfiles({ discoveredConstraints, complianceSignals, contributorCount, codebaseAgeDays }) {
  const suggestions = [];

  // Compliance signals → enterprise/regulated
  const complianceArr = Array.isArray(complianceSignals) ? complianceSignals : [];
  if (complianceArr.length >= 2 || /hipaa|fedramp|gdpr|soc2/i.test(complianceArr.join(" "))) {
    suggestions.push("enterprise_regulated");
  }

  // Team size signals
  const team = Number(contributorCount) || 0;
  if (team > 0 && team <= 3) {
    suggestions.push("pre_pmf_solo");
  } else if (team >= 4 && team <= 10) {
    suggestions.push("first_paying_customers");
  } else if (team >= 11 && team <= 30) {
    suggestions.push("scaling_team_post_seed");
  }

  // Codebase age signals
  const age = Number(codebaseAgeDays) || 0;
  if (age > 0 && age < 30 && !suggestions.includes("pre_pmf_solo")) {
    suggestions.unshift("pre_pmf_solo");
  }

  // De-dup while preserving order; cap at 3 suggestions.
  const seen = new Set();
  const ranked = [];
  for (const id of suggestions) {
    if (seen.has(id)) continue;
    seen.add(id);
    ranked.push(id);
    if (ranked.length >= 3) break;
  }

  return ranked.map((id) => PROFILES.find((p) => p.id === id)).filter(Boolean);
}

function profileById(id) {
  return PROFILES.find((p) => p.id === id) || null;
}

function profileAnswersAsText(profile) {
  if (!profile) return "";
  return [
    `## Clarification answers (profile: ${profile.label})`,
    "",
    ...Object.entries(profile.answers).map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
  ].join("\n");
}

export { PROFILES, suggestProfiles, profileById, profileAnswersAsText };
