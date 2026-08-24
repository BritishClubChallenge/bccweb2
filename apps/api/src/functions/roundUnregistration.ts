// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { RoundSchema } from "@bccweb/schemas";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { withPrivateLease } from "../lib/blob.js";
import { writePrivateJson } from "../lib/blobJson.js";
import { trustedClientIp } from "../lib/clientIp.js";
import { HttpError } from "../lib/http.js";
import { rateLimit } from "../lib/rateLimit.js";
import { getLatestSignature } from "../lib/signTofly/ledger.js";
import { readRegistrationRound } from "./roundRegistrationData.js";
import {
  clearRegistrationSlot,
  ensureRegistrationOpen,
  findPilotRegistrationSlot,
} from "./roundRegistrationRoster.js";

export async function unregisterSelf(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Pilot") || !caller.pilotId) {
    throw new HttpError(403, "NOT_A_PILOT");
  }
  const pilotId = caller.pilotId;

  rateLimit(req, {
    endpoint: "round-register",
    capacity: 10,
    refillPerMin: 10,
    identityKey: pilotId ?? `anon:${trustedClientIp(req) ?? "unknown"}`,
  });

  const roundId = req.params["roundId"];
  if (!roundId) {
    throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");
  }

  const round = await readRegistrationRound(roundId);
  ensureRegistrationOpen(round, "UNREGISTRATION_CLOSED");
  const existing = findPilotRegistrationSlot(round, pilotId);
  if (!existing) {
    throw new HttpError(
      404,
      "NOT_REGISTERED",
      "You are not registered in this round"
    );
  }

  const signature = await getLatestSignature(
    roundId,
    existing.team.id,
    existing.slot.placeInTeam,
    pilotId
  );
  if (signature) throwSignedContactCoordinator();

  await withPrivateLease(`rounds/${roundId}.json`, async (leaseId) => {
    const lockedRound = await readRegistrationRound(roundId);
    ensureRegistrationOpen(lockedRound, "UNREGISTRATION_CLOSED");
    const lockedSlot = findPilotRegistrationSlot(lockedRound, pilotId);
    if (!lockedSlot) {
      throw new HttpError(
        404,
        "NOT_REGISTERED",
        "You are not registered in this round"
      );
    }

    const lockedSignature = await getLatestSignature(
      roundId,
      lockedSlot.team.id,
      lockedSlot.slot.placeInTeam,
      pilotId
    );
    if (lockedSignature) throwSignedContactCoordinator();

    clearRegistrationSlot(lockedSlot.slot);
    await writePrivateJson(
      `rounds/${roundId}.json`,
      RoundSchema,
      lockedRound,
      leaseId
    );
  });

  return {
    status: 200,
    jsonBody: {
      roundId,
      removedFromTeamId: existing.team.id,
      removedFromPlace: existing.slot.placeInTeam,
    },
  };
}

function throwSignedContactCoordinator(): never {
  throw new HttpError(
    409,
    "SIGNED_CONTACT_COORD",
    "You have already signed to fly; ask a coordinator to remove you."
  );
}
