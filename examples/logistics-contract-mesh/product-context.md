# Product Context: Logistics Contract Mesh

We are building a highly audited contract analysis engine for global logistics teams.

The system must answer questions across vendors, facilities, contracts, contract clauses, jurisdictions, shipment lanes, regulatory changes, source documents, and evidence spans. The core user is a legal or operations analyst who needs to trace supply-chain exposure across multiple documents.

Representative questions:

- Show me active vendor contracts for the EMEA region.
- If maritime rules change for Rotterdam, which vendors and contract clauses are exposed to immediate breach liability?
- Which facilities depend on a Tier-2 supplier that is governed by a jurisdiction with a new regulatory change?
- Why did the system claim that a vendor is exposed, and which source spans support that answer?

Important constraints:

- The system must preserve audit traceability and lineage for every compliance-critical answer.
- Multi-hop relationship traversal is required across Vendor, Facility, ContractClause, Jurisdiction, and ShipmentLane.
- The system must abstain when source-backed evidence cannot connect the requested entities.
- Agentic research is allowed for analyst exploration, but compliance-critical answers need deterministic routing and replayable execution.
- Bounded contexts should separate ingestion, graph extraction, query orchestration, and traceability audit.
- The p95 latency target for a reviewed answer path is 2500ms after indexing.
- Budget matters because ingestion may process thousands of contracts and appendices.
