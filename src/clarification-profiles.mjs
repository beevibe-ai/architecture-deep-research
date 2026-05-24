// Pre-built context tag sets for ADR runs.
//
// Real users don't want to answer six free-form questions about latency /
// scale / cost / compliance / region / team size. They want to pick the
// profile that matches their stage. Each profile carries a flat array of
// context tags — short strings like "phase:pre_pmf", "deployment:self_hosted"
// — that ADR threads into decision-context.json as a `tags: [...]` array.
//
// Tags are CONTEXT, not filters. They are shown in the report header and
// passed to synthesis as soft annotations. They never narrow the candidate
// pool.
//
// Match hints look at discover-derived signals to suggest 1-2 profiles:
//   - codebase_age_days: very young (< 30d) → pre-PMF defaults
//   - team_size_hint: solo / 1-3 → pre-PMF defaults; 3-10 → first-customers;
//     10+ → scaling-team
//   - compliance_signals presence: triggers enterprise / regulated profiles

const PROFILES = [
  {
    id: "pre_pmf_solo",
    label: "Pre-PMF / solo founder",
    description:
      "Pre-product-market-fit. Solo or 1-3 engineers. Optimizing for time-to-first-customer, not scale. Self-hosted on a single VM or Docker Compose. Budget under $50/mo.",
    tags: [
      "phase:pre_pmf",
      "team:1-3",
      "cost_sensitivity:high",
      "deployment:self_hosted_preferred",
      "scale:under_10_tenants",
      "compliance:none",
      "lifecycle:iteration_speed_dominates"
    ]
  },
  {
    id: "first_paying_customers",
    label: "First paying customers",
    description:
      "Post-PMF, early revenue. Small team (3-10). Some customers paying, want SOC2 in 12 months. Managed platform deploy (Railway / Fly / Vercel). Budget $50-500/mo per tenant.",
    tags: [
      "phase:early_revenue",
      "team:3-10",
      "cost_sensitivity:medium",
      "deployment:managed_cloud",
      "scale:10-100_tenants",
      "compliance:soc2_planned",
      "latency:p95_under_500ms",
      "lifecycle:durable_layer"
    ]
  },
  {
    id: "scaling_team_post_seed",
    label: "Scaling team / post-seed",
    description:
      "Funded round, 10-30 engineers. Multiple customers across regions. SOC2 + GDPR required. Multi-region cloud. Budget $500-5000/mo per tenant. p95 latency matters.",
    tags: [
      "phase:post_seed",
      "team:10-30",
      "cost_sensitivity:low",
      "deployment:multi_region_managed",
      "scale:100plus_tenants",
      "compliance:soc2_required",
      "compliance:gdpr",
      "compliance:eu_data_residency",
      "latency:p95_under_200ms",
      "lifecycle:3_5_year_horizon"
    ]
  },
  {
    id: "enterprise_regulated",
    label: "Enterprise / regulated industry",
    description:
      "Healthcare, finance, gov, or large enterprise. HIPAA / FedRAMP / SOC2 / GDPR. Self-host option required. Air-gapped or on-prem deploy. Strict latency SLAs.",
    tags: [
      "phase:enterprise",
      "team:30plus",
      "cost_sensitivity:control_dominates",
      "deployment:self_host_required",
      "deployment:on_prem_or_air_gapped",
      "scale:high_availability",
      "compliance:hipaa",
      "compliance:soc2_type_ii",
      "compliance:gdpr",
      "compliance:fedramp_possible",
      "compliance:audit_logs_required",
      "latency:p99_under_100ms",
      "lifecycle:10_year_horizon",
      "lock_in:board_level_concern"
    ]
  }
];

// Suggest 1-3 profiles that match the discover signals. Returns ranked
// profile IDs (best match first). Empty array if no signals are
// confident — the caller falls back to whatever decision-context the PRD
// itself produces.
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

// Flatten a profile's tags into a header block that can be appended to
// content (or rendered for reader visibility).
function profileTagsAsText(profile) {
  if (!profile) return "";
  return [
    `## Context tags (profile: ${profile.label})`,
    "",
    ...profile.tags.map((tag) => `- ${tag}`)
  ].join("\n");
}

export { PROFILES, suggestProfiles, profileById, profileTagsAsText };
