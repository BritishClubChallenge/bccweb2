// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { CallSiteCase } from "./issue8EvidenceHarness.js";
import {
  coordCoarse,
  seedEvidenceUser,
} from "./issue8EvidenceHarness.js";
import { roundWithFlight } from "./issue8EvidenceFixtures.js";

export const COARSE_SELF_CASES: readonly CallSiteCase[] = [
  { file: "flights.ts", handler: "logFlight", endpoint: "logFlight", tier: "flights", forbiddenKind: "self-or-admin", setup: async () => ({ forbidden: await seedEvidenceUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "POST", params: { id: randomUUID() }, body: { pilotId: randomUUID(), distance: 1 } } }) },
  { file: "flights.ts", handler: "updateFlight", endpoint: "updateFlight", tier: "flights", forbiddenKind: "self-or-admin", setup: async () => { const flightId = randomUUID(); const ownerPilotId = randomUUID(); const round = await roundWithFlight(flightId, ownerPilotId); return { forbidden: await seedEvidenceUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "PUT", params: { id: round.id, flightId }, body: { distance: 11 } } }; } },
  { file: "flights.ts", handler: "deleteFlight", endpoint: "deleteFlight", tier: "flights", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), flightId: randomUUID() }) },
  { file: "pilots.ts", handler: "updatePilot", endpoint: "updatePilot", tier: "standard", forbiddenKind: "self-or-admin", setup: async () => ({ forbidden: await seedEvidenceUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "PUT", params: { id: randomUUID() }, body: { firstName: "Nope" } } }) },
  { file: "roundsMutate.ts", handler: "createRound", endpoint: "createRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", {}, { date: "2026-06-01", siteId: randomUUID(), seasonYear: 2026 }) },
  { file: "roundsMutate.ts", handler: "updateRound", endpoint: "updateRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("PUT", { id: randomUUID() }, { maxTeams: 4 }) },
  { file: "roundTransitions.ts", handler: "confirmRound", endpoint: "confirmRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "briefCompleteRound", endpoint: "briefCompleteRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  // reopenBrief gates TWICE, once per path: ?dryRun=true takes the preview
  // branch's own literal call site in roundsMutate.ts, and the real transition
  // takes the table's. Both must reject the coarse caller with 403.
  { file: "roundsMutate.ts", handler: "reopenBrief", endpoint: "reopenBrief", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }, {}, { dryRun: "true" }) },
  { file: "roundTransitions.ts", handler: "reopenBrief", endpoint: "reopenBrief", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "lockRound", endpoint: "lockRound", tier: "heavy", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "unlockRound", endpoint: "unlockRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "completeRound", endpoint: "completeRound", tier: "heavy", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundTransitions.ts", handler: "cancelRound", endpoint: "cancelRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundTransitions.ts", handler: "uncancelRound", endpoint: "uncancelRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "teams.ts", handler: "addTeam", endpoint: "addTeam", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }, { clubId: randomUUID(), teamName: "Alpha" }) },
  { file: "teams.ts", handler: "removeTeam", endpoint: "removeTeam", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), teamId: randomUUID() }) },
  { file: "teams.ts", handler: "addPilot", endpoint: "addPilot", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID(), teamId: randomUUID() }, { pilotId: randomUUID() }) },
  { file: "teams.ts", handler: "removePilot", endpoint: "removePilot", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), teamId: randomUUID(), place: "1" }) },
];
