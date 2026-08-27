// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash, randomUUID } from "node:crypto";
import { BlobClient } from "@azure/storage-blob";
import type {
  Pilot,
  Round,
  RoundBrief,
  Season,
  SeasonResults,
  Signature,
  SignToFlyWording,
} from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, invokeQueue, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer, getPublicContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeClub,
  makeClubTeam,
  makeConfig,
  makePilot,
  makeSite,
  makeUser,
  privateBlobExists,
  publicBlobExists,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { signaturePath } from "../../lib/signTofly/ledger.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import * as pureTrack from "../../lib/puretrack.js";

// One-shot seam: run a racing write AFTER completeRound's pre-lease read but
// BEFORE it acquires the completion lease, so a test can prove scoring runs on
// the LEASED read (W3.1). Default null → no-op for every other test.
const leaseHook = vi.hoisted(() => ({
  beforePrivateRenewing: null as null | ((path: string) => Promise<void>),
}));
const blobJsonHook = vi.hoisted(() => ({
  configReadError: null as null | Error,
}));

vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    readJson: async <T>(...args: Parameters<typeof actual.readJson<T>>): Promise<T> => {
      const error = blobJsonHook.configReadError;
      if (args[2] === "config.json" && error) {
        blobJsonHook.configReadError = null;
        throw error;
      }
      return actual.readJson(...args);
    },
  };
});

vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withLeaseRenewing: <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withLeaseRenewing>[2] = {},
    ) => actual.withLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts }),
    withPrivateLeaseRenewing: async <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withPrivateLeaseRenewing>[2] = {},
    ) => {
      const hook = leaseHook.beforePrivateRenewing;
      if (hook) {
        leaseHook.beforePrivateRenewing = null;
        await hook(path);
      }
      return actual.withPrivateLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts });
    },
  };
});

const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn(),
}));

vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

const emailMock = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  briefHtmlBody: vi.fn().mockReturnValue("<p>brief</p>"),
  briefPlainText: vi.fn().mockReturnValue("brief"),
}));

vi.mock("../../lib/email.js", () => ({
  sendEmail: emailMock.sendEmail,
  briefHtmlBody: emailMock.briefHtmlBody,
  briefPlainText: emailMock.briefPlainText,
}));

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
  enqueuePureTrackGroupJob: vi.fn(),
}));

import { sendEmail } from "../../lib/email.js";
import { enqueueBriefPdf, enqueuePureTrackGroupJob } from "../../lib/queue.js";
import { recomputeSeason } from "../../lib/recompute.js";
import "../roundsMutate.js";
import "../teams.js";
import "../signatures.js";
import "../signaturesReflect.js";
import "../brief.js";

describe("round lifecycle integration", () => {
  const restoredSpies: Array<() => void> = [];

  beforeEach(() => {
    blobJsonHook.configReadError = null;
    vi.clearAllMocks();
    pdfMock.generateBriefPdf.mockResolvedValue(Buffer.from("%PDF-1.4 lifecycle"));
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    vi.mocked(enqueuePureTrackGroupJob).mockResolvedValue(undefined);
  });

  afterEach(() => {
    blobJsonHook.configReadError = null;
    leaseHook.beforePrivateRenewing = null;
    while (restoredSpies.length) restoredSpies.pop()?.();
    vi.restoreAllMocks();
  });

  it("happy path create -> confirm -> brief-complete -> sign -> lock enqueues PDF job and freezes brief metadata", async () => {
    const createPureTrackGroupsSpy = vi.spyOn(pureTrack, "createPureTrackGroups");
    const ctx = await seedCreatedRoundViaHandlers();
    await seedBrief(ctx, { windSpeedDirection: "W 10kt" });

    await expect(statusTransition("confirmRound", ctx)).resolves.toMatchObject({ status: 200 });
    await expect(statusTransition("briefCompleteRound", ctx)).resolves.toMatchObject({ status: 200 });

    const signRes = await signOwnSlot(ctx);
    expect(signRes.status).toBe(201);
    await invokeQueue("signToFlyReflect", { roundId: ctx.roundId }, {});
    const signedBeforeLock = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(signedBeforeLock?.teams[0].pilots[0].signToFly).toBe(true);

    vi.mocked(enqueuePureTrackGroupJob).mockImplementationOnce(async (job) => {
      const committed = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
      expect(committed?.status).toBe("Locked");
      expect(committed?.pureTrack).toMatchObject({ status: "pending", attemptId: job.attemptId });
    });
    const lockRes = await lockRound(ctx);

    expect(lockRes.status).toBe(200);
    expect(pdfMock.generateBriefPdf).toHaveBeenCalledTimes(0);
    expect(sendEmail).toHaveBeenCalledTimes(0);
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.pdf`)).toBe(false);
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(true);
    const locked = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(locked.status).toBe("Locked");
    expect(locked.brief?.version).toBe(1);
    expect(locked.brief?.pdfPath).toBe(`round-briefs/${ctx.roundId}.pdf`);
    expect(locked.brief?.pdfStatus).toBe("pending");
    expect(locked.brief?.pdfAttemptId).toBeTruthy();
    expect(locked.pureTrack?.status).toBe("pending");
    expect(locked.pureTrack?.attemptId).toBeTruthy();
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      briefVersion: 1,
      pdfAttemptId: locked.brief?.pdfAttemptId,
    });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      attemptId: locked.pureTrack?.attemptId,
    });
    expect(createPureTrackGroupsSpy).not.toHaveBeenCalled();
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1))).toMatchObject({
      pilotId: ctx.pilotId,
      source: "pilot-self",
    });
  });

  it("completeRound flips Complete and T11 recompute updates season, results, rounds index with no tmp after success", async () => {
    const ctx = await seedLockedScorableRound();

    const completeRes = await completeRound(ctx);
    await waitForPublicBlob(`results/${ctx.year}.json`);

    expect(completeRes.status).toBe(200);
    const completed = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(completed.status).toBe("Complete");
    expect(completed.isLocked).toBe(false);
    // Scored on the LEASED read: the single scoring pilot normalises to
    // maxPointsForRound, and team.score is an integer (banker's-rounded).
    expect(completed.teams[0].pilots[0].pilotPoints).toBe(100);
    expect(completed.teams[0].score).toBe(100);
    expect(Number.isInteger(completed.teams[0].score)).toBe(true);
    expect(completed.scoring?.scoredAt).toBeTruthy();
    expect(completed.scoring?.maxPointsForRound).toBe(100);
    expect(completed.scoring?.maxPilotScoreInRound).toBe(42);
    expect(completed.scoring?.maxTeamScore).toBe(100);
    expect(completed.scoring?.teams).toEqual([{ teamId: ctx.teamId, workingTeamScore: 100 }]);
    const season = (await readPublicJson<Season>(`seasons/${ctx.year}.json`))!;
    const results = (await readPublicJson<SeasonResults>(`results/${ctx.year}.json`))!;
    const roundsIndex = (await readPublicJson<Array<{ id: string; status: string }>>("rounds.json"))!;
    expect(season.rounds).toContain(ctx.roundId);
    expect(season.leagueTable.length).toBeGreaterThan(0);
    expect(results.some((result) => result.roundId === ctx.roundId)).toBe(true);
    expect(roundsIndex.find((round) => round.id === ctx.roundId)?.status).toBe("Complete");
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(false);
    await expect(publicBlobExists(`results/${ctx.year}.json.tmp`)).resolves.toBe(false);
    await expect(publicBlobExists("rounds.json.tmp")).resolves.toBe(false);
  });

  it("completeRound scores the LEASED read so a racing no-score edit is not stale-overwritten", async () => {
    const ctx = await seedLockedScorableRound();
    // Given: a coordinator models a real no-score withdrawal by removing the pilot's flight in an edit that commits AFTER
    // completeRound's pre-lease read but BEFORE it acquires the completion lease.
    leaseHook.beforePrivateRenewing = async (path) => {
      if (path !== `rounds/${ctx.roundId}.json`) return;
      const racing = (await readPrivateJson<Round>(path))!;
      racing.teams[0].pilots[0].noScore = true;
      racing.teams[0].pilots[0].flight = null;
      racing.teams[0].pilots[0].pilotPoints = 0;
      await writePrivateJson(path, racing);
    };

    const res = await completeRound(ctx);

    expect(res.status).toBe(200);
    const completed = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(completed.status).toBe("Complete");
    // Then: the racing no-score withdrawal wins — scoring ran on the leased read, so the
    // stale scorable snapshot (which would have yielded 100) did not overwrite it.
    expect(completed.teams[0].pilots[0].noScore).toBe(true);
    expect(completed.teams[0].pilots[0].pilotPoints).toBe(0);
    expect(completed.teams[0].score).toBe(0);
    expect(completed.scoring?.maxPilotScoreInRound).toBe(0);
    expect(completed.scoring?.teams).toEqual([{ teamId: ctx.teamId, workingTeamScore: 0 }]);
    await recomputeSeason(ctx.year);
  });

  it("completeRound fails and leaves the round Locked when config storage is unavailable", async () => {
    const ctx = await seedLockedScorableRound();
    blobJsonHook.configReadError = Object.assign(new Error("transient config read failure"), {
      statusCode: 503,
    });

    const res = await completeRound(ctx);

    expect(res.status).toBe(500);
    const persisted = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(persisted).toMatchObject({ status: "Locked", isLocked: true });
    expect(persisted?.teams[0]?.pilots[0]?.pilotPoints).toBe(0);
  });

  it("completeRound returns 409 PILOTS_NOT_ACCOUNTED_FOR before reading config when a Filled slot is unswept", async () => {
    const ctx = await seedLockedScorableRound();
    const path = `rounds/${ctx.roundId}.json`;
    const locked = (await readPrivateJson<Round>(path))!;
    locked.teams[0].pilots[0].accountedFor = false;
    await writePrivateJson(path, locked);
    // Config reads fail — so a 500 here would mean the gate ran too late.
    blobJsonHook.configReadError = Object.assign(new Error("transient config read failure"), {
      statusCode: 503,
    });

    const res = await completeRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOTS_NOT_ACCOUNTED_FOR");
    expect((res.jsonBody as { detail?: string }).detail).toBe(
      `Unaccounted-for slots: Alpha #1 (${ctx.pilotId})`,
    );
    const persisted = await readPrivateJson<Round>(path);
    expect(persisted).toMatchObject({ status: "Locked", isLocked: true });
  });

  it("lockRound when status is not BriefComplete returns 409 INVALID_STATE-style conflict", async () => {
    const ctx = await seedLifecycleRound({ status: "Confirmed" });

    const res = await lockRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string; error?: string }).code).toBe("CONFLICT");
    expect((res.jsonBody as { error?: string }).error).toBe("Conflict");
  });

  it("completeRound when status is not Locked returns 409 INVALID_STATE-style conflict", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });

    const res = await completeRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string; error?: string }).code).toBe("CONFLICT");
    expect((res.jsonBody as { error?: string }).error).toBe("Conflict");
  });

  it.each(["Proposed", "Confirmed"] as const)(
    "cancelRound from %s flips Cancelled and republishes it to public rounds.json",
    async (status) => {
      const ctx = await seedLifecycleRound({ status });

      const res = await cancelRound(ctx);

      expect(res.status).toBe(200);
      expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Cancelled");
      const idx = (await readPublicJson<Array<{ id: string; status: string }>>("rounds.json"))!;
      expect(idx.find((round) => round.id === ctx.roundId)?.status).toBe("Cancelled");
    },
  );

  it("cancelRound from BriefComplete returns 409 and leaves status unchanged", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });

    const res = await cancelRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("CONFLICT");
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("BriefComplete");
  });

  it("uncancelRound from Cancelled flips Proposed and republishes it to public rounds.json", async () => {
    const ctx = await seedLifecycleRound({ status: "Cancelled" });

    const res = await uncancelRound(ctx);

    expect(res.status).toBe(200);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Proposed");
    const idx = (await readPublicJson<Array<{ id: string; status: string }>>("rounds.json"))!;
    expect(idx.find((round) => round.id === ctx.roundId)?.status).toBe("Proposed");
  });

  it("uncancelRound from Proposed returns 409", async () => {
    const ctx = await seedLifecycleRound({ status: "Proposed" });

    const res = await uncancelRound(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("CONFLICT");
  });

  it("updateRound on a Cancelled round returns 409 ROUND_CANCELLED and leaves fields unchanged", async () => {
    const ctx = await seedLifecycleRound({ status: "Cancelled" });

    const res = await updateRoundMeta(ctx, { maxTeams: 4 });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_CANCELLED");
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.maxTeams).toBe(8);
  });

  it("updateRound on a Locked round returns 409 CONFLICT and leaves fields unchanged", async () => {
    const ctx = await seedLifecycleRound({ status: "Locked", isLocked: true });

    const res = await updateRoundMeta(ctx, { maxTeams: 4 });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string; error?: string }).code).toBe("CONFLICT");
    expect((res.jsonBody as { error?: string }).error).toBe("Conflict");
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.maxTeams).toBe(8);
  });

  it("updateRound clears stale flight date validation after unlock while preserving signature and override", async () => {
    const ctx = await seedLockedScorableRound();
    const path = `rounds/${ctx.roundId}.json`;
    const locked = (await readPrivateJson<Round>(path))!;
    const flight = locked.teams[0]?.pilots[0]?.flight;
    if (!flight) throw new Error("Expected seeded flight");
    flight.validation = { signature: "invalid", date: "valid", overridden: true };
    flight.sanityFlags = ["IGC_DATE_MISMATCH", "GPS_SPIKE"];
    await writePrivateJson(path, locked);
    await expect(unlockRound(ctx)).resolves.toMatchObject({ status: 200 });

    const res = await updateRoundMeta(ctx, { date: `${ctx.year}-06-10` });

    expect(res.status).toBe(200);
    const updated = await readPrivateJson<Round>(path);
    expect(updated?.date).toBe(`${ctx.year}-06-10`);
    expect(updated?.teams[0]?.pilots[0]?.flight?.validation).toEqual({
      signature: "invalid",
      overridden: true,
    });
    expect(updated?.teams[0]?.pilots[0]?.flight?.sanityFlags).toEqual(["GPS_SPIKE"]);
  });

  it("updateRound re-scores a Complete round after clearing stale flight date validation", async () => {
    const ctx = await seedLockedScorableRound({ complete: true });
    await makeConfig({ flightDateValidationEnabled: true });
    const path = `rounds/${ctx.roundId}.json`;
    const round = await readPrivateJson<Round>(path);
    const team = round?.teams[0];
    const dateInvalidSlot = team?.pilots[0];
    if (!round || !team || !dateInvalidSlot?.flight) throw new Error("Expected seeded flight");
    const validPilotId = randomUUID();
    dateInvalidSlot.flight.validation = { date: "invalid" };
    dateInvalidSlot.flight.sanityFlags = ["IGC_DATE_MISMATCH", "GPS_SPIKE"];
    dateInvalidSlot.flight.score = 0;
    dateInvalidSlot.flight.wingFactor = 0;
    dateInvalidSlot.pilotPoints = 0;
    team.pilots.push({
      ...structuredClone(dateInvalidSlot),
      placeInTeam: 2,
      pilotId: validPilotId,
      pilotPoints: 200,
      flight: {
        ...structuredClone(dateInvalidSlot.flight),
        id: randomUUID(),
        score: 42,
        wingFactor: 1,
        validation: { signature: "valid" },
        sanityFlags: ["GPS_SPIKE"],
      },
    });
    team.score = 200;
    await writePrivateJson(path, round);

    const res = await updateRoundMeta(ctx, { date: `${ctx.year}-06-10` });

    expect(res.status).toBe(200);
    const updated = await readPrivateJson<Round>(path);
    if (!updated) throw new Error("Expected updated round");
    expect(updated.teams[0]?.pilots[0]?.flight?.validation).toEqual({});
    expect(updated.teams[0]?.pilots[0]?.flight?.sanityFlags).toEqual(["GPS_SPIKE"]);
    expect(updated.teams[0]?.pilots[0]?.pilotPoints).toBe(200);
    expect(updated.teams[0]?.pilots[1]?.flight?.validation).toEqual({ signature: "valid" });
    expect(updated.teams[0]?.pilots[1]?.flight?.sanityFlags).toEqual(["GPS_SPIKE"]);
    expect(updated.teams[0]?.pilots[1]?.pilotPoints).toBe(200);
    await recomputeSeason(ctx.year);
    const season = await readPublicJson<Season>(`seasons/${ctx.year}.json`);
    if (!season) throw new Error("Expected recomputed season");
    expect(season.leagueTable[0]?.roundScores[ctx.roundId]).toBe(200);
    const results = await readPublicJson<SeasonResults>(`results/${ctx.year}.json`);
    if (!results) throw new Error("Expected recomputed season results");
    const roundResult = results.find((result) => result.roundId === ctx.roundId);
    expect(roundResult?.teamResults[0]?.pilots).toEqual(expect.arrayContaining([
      expect.objectContaining({ pilotId: ctx.pilotId, score: 200 }),
      expect.objectContaining({ pilotId: validPilotId, score: 200 }),
    ]));
  });

  it("updateRound keeps a Complete round date change successful when season recompute fails", async () => {
    // Given: publishing the re-scored Complete round fails after its private score is committed.
    const ctx = await seedLockedScorableRound({ complete: true });
    const original = BlobClient.prototype.beginCopyFromURL;
    const publishSpy = vi.spyOn(BlobClient.prototype, "beginCopyFromURL")
      .mockImplementationOnce(function (this: BlobClient, source, options) {
        if (this.name === `seasons/${ctx.year}.json`) throw new Error("transient season publish failure");
        return original.call(this, source, options);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // When: the round date changes and triggers re-scoring plus a best-effort season recompute.
    const res = await updateRoundMeta(ctx, { date: `${ctx.year}-06-10` });

    // Then: the PUT succeeds with the private score committed, and an admin recompute can publish it.
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({
      date: `${ctx.year}-06-10`,
      teams: [expect.objectContaining({ score: 100 })],
    });
    const updated = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(updated?.date).toBe(`${ctx.year}-06-10`);
    expect(updated?.teams[0]?.score).toBe(100);
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        `[updateRound] recomputeSeason(${ctx.year}) failed:`,
        expect.objectContaining({ message: "transient season publish failure" }),
      );
    });

    publishSpy.mockRestore();
    await recomputeSeason(ctx.year);
    const season = await readPublicJson<Season>(`seasons/${ctx.year}.json`);
    expect(season?.leagueTable[0]?.roundScores[ctx.roundId]).toBe(100);
    const results = await readPublicJson<SeasonResults>(`results/${ctx.year}.json`);
    expect(results?.find((result) => result.roundId === ctx.roundId)?.teamResults[0]?.score).toBe(100);
  });

  it("updateRound with an unknown siteId returns 409 CONFLICT and leaves the site unchanged", async () => {
    const ctx = await seedLifecycleRound({ status: "Proposed" });

    const res = await updateRoundMeta(ctx, { siteId: randomUUID() });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("CONFLICT");
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.site.id).toBe(ctx.siteId);
  });

  it("brief edit when round is Locked returns 409 BRIEF_LOCKED", async () => {
    const ctx = await seedLifecycleRound({ status: "Locked", isLocked: true });
    await seedBrief(ctx);

    const res = await updateBrief(ctx, makeBrief(ctx, { siteName: "Cosmetic" }));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_LOCKED");
  });

  it("brief edit when round is BriefComplete returns 409 BRIEF_LOCKED", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await updateBrief(ctx, makeBrief(ctx, { NOTAMs: "attempted edit after brief-complete" }));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_LOCKED");
    const after = (await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`))!;
    expect(after.NOTAMs).toBeUndefined();
  });

  it("double-lock race allows exactly one lock to succeed", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete", preSign: true });
    await seedBrief(ctx);

    const settled = await Promise.allSettled([lockRound(ctx), lockRound(ctx)]);

    const statuses = settled.map((result) => result.status === "fulfilled" ? result.value.status : 500);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200)).toHaveLength(1);
    const locked = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(locked?.status).toBe("Locked");
  });

  it("recompute crash leaves prior final blob intact, tmp present, and rerun succeeds", async () => {
    const ctx = await seedLockedScorableRound({ complete: true });
    const prior: Season = { id: `season-${ctx.year}`, year: ctx.year, active: true, rounds: [ctx.roundId], leagueTable: [] };
    await writePublicJson(`seasons/${ctx.year}.json`, prior);
    const original = BlobClient.prototype.beginCopyFromURL;
    vi.spyOn(BlobClient.prototype, "beginCopyFromURL").mockImplementationOnce(function (this: BlobClient, source, options) {
      if (this.name === `seasons/${ctx.year}.json`) throw new Error("copy failed after tmp write");
      return original.call(this, source, options);
    });
    restoredSpies.push(() => vi.restoreAllMocks());

    await expect(recomputeSeason(ctx.year)).rejects.toThrow("copy failed after tmp write");
    await expect(readPublicJson<Season>(`seasons/${ctx.year}.json`)).resolves.toEqual(prior);
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(true);

    vi.restoreAllMocks();
    await recomputeSeason(ctx.year);
    const season = (await readPublicJson<Season>(`seasons/${ctx.year}.json`))!;
    expect(season.leagueTable.length).toBeGreaterThan(0);
    await expect(publicBlobExists(`seasons/${ctx.year}.json.tmp`)).resolves.toBe(false);
  });

  it("recomputeSeason is deterministic across repeated runs", async () => {
    const ctx = await seedLockedScorableRound({ complete: true });

    await recomputeSeason(ctx.year);
    const first = await readPublicBytes(`seasons/${ctx.year}.json`);
    await recomputeSeason(ctx.year);
    const second = await readPublicBytes(`seasons/${ctx.year}.json`);

    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("pilot signs own slot with all audit fields and canonical private path", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await signOwnSlot(ctx);

    expect(res.status).toBe(201);
    const sig = (await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1)))!;
    expect(sig).toMatchObject({
      roundId: ctx.roundId,
      teamId: ctx.teamId,
      place: 1,
      pilotId: ctx.pilotId,
      userId: ctx.pilotUserId,
      briefVersion: 1,
      wordingVersion: 1,
      ip: "203.0.113.42",
      userAgent: "round-lifecycle-test",
      source: "pilot-self",
    });
    expect(sig.id).toBeTruthy();
    expect(sig.signedAt).toBeTruthy();
    expect(sig.briefHash).toBeTruthy();
    expect(sig.wordingHash).toBeTruthy();
  });

  it("pilot signing another pilot's slot returns 403 NOT_YOUR_SLOT", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);
    const otherPilotId = randomUUID();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: otherPilotId });

    const res = await signOwnSlot(ctx, { userId: user.id, email: user.email });

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT");
  });

  it("coordinator override with reason at least 20 chars writes coord-override signature and audit log", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await overrideSign(ctx, "Pilot completed a paper declaration at launch");

    expect(res.status).toBe(201);
    expect(res.jsonBody).toMatchObject({
      source: "coord-override",
      overrideBy: ctx.adminUserId,
      overrideReason: "Pilot completed a paper declaration at launch",
    });
    const audit = await readAuditLines();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (res.jsonBody as Signature).id,
        source: "coord-override",
        audit: expect.objectContaining({ signaturePath: expect.stringContaining("-override-") }),
      }),
    ]));
  });

  it("coordinator override with short reason returns 400 INVALID_REASON", async () => {
    const ctx = await seedLifecycleRound({ status: "BriefComplete" });
    await seedBrief(ctx);

    const res = await overrideSign(ctx, "too short");

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("INVALID_REASON");
  });

  it("PureTrack enqueue failure during lock writes no group blob and lock still succeeds", async () => {
    vi.mocked(enqueuePureTrackGroupJob).mockRejectedValueOnce(new Error("queue unavailable"));
    const ctx = await seedLifecycleRound({ status: "BriefComplete", pilotPureTrackId: 12345, preSign: true });
    await seedBrief(ctx);

    const res = await lockRound(ctx);
    const pureTrackBlobs = await listPrivateBlobNames("puretrack-groups/");

    expect(res.status).toBe(200);
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
    expect(pureTrackBlobs).not.toEqual(expect.arrayContaining([expect.stringContaining(ctx.roundId)]));
    const locked = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(locked?.status).toBe("Locked");
    expect(locked?.pureTrack?.status).toBe("failed");
    expect(locked?.pureTrack?.error).toBe("enqueue_failed");
  });
});

interface LifecycleContext {
  year: number;
  roundId: string;
  teamId: string;
  clubId: string;
  siteId: string;
  pilotId: string;
  adminUserId: string;
  adminEmail: string;
  pilotUserId: string;
  pilotEmail: string;
}

async function seedCreatedRoundViaHandlers(): Promise<LifecycleContext> {
  const base = await seedBaseEntities();
  const createRes = await invoke("createRound", makeAuthRequest(base.adminUserId, base.adminEmail, {
    method: "POST",
    body: {
      date: `${base.year}-06-09`,
      siteId: base.siteId,
      seasonYear: base.year,
      organisingClubId: base.clubId,
      briefingTime: "10:00",
      landByTime: "18:00",
      checkInByTime: "19:00",
    },
  }));
  expect(createRes.status).toBe(201);
  const roundId = (createRes.jsonBody as Round).id;

  const addTeamRes = await invoke("addTeam", makeAuthRequest(base.adminUserId, base.adminEmail, {
    method: "POST",
    params: { id: roundId },
    body: { clubId: base.clubId, teamName: "Alpha" },
  }));
  expect(addTeamRes.status).toBe(200);
  const teamId = ((addTeamRes.jsonBody as Round).teams[0]).id;

  const addPilotRes = await invoke("addPilot", makeAuthRequest(base.adminUserId, base.adminEmail, {
    method: "POST",
    params: { id: roundId, teamId },
    body: { pilotId: base.pilotId, isScoring: true },
  }));
  expect(addPilotRes.status).toBe(200);

  // Filled slots need a snapshot to pass brief-complete's roster gate.
  const created = (await readPrivateJson<Round>(`rounds/${roundId}.json`))!;
  for (const team of created.teams) {
    for (const slot of team.pilots) {
      if (slot.status === "Filled" && slot.pilotId) slot.snapshot = { wingClass: "EN B", pilotRating: "Pilot" };
    }
  }
  await writePrivateJson(`rounds/${roundId}.json`, created);

  return { ...base, roundId, teamId };
}

async function seedLifecycleRound(opts: {
  status?: Round["status"];
  isLocked?: boolean;
  pilotPureTrackId?: number;
  flightDistance?: number;
  complete?: boolean;
  preSign?: boolean;
} = {}): Promise<LifecycleContext> {
  const base = await seedBaseEntities({ pilotPureTrackId: opts.pilotPureTrackId });
  const teamId = randomUUID();
  const roundId = randomUUID();
  const status = opts.complete ? "Complete" : opts.status ?? "BriefComplete";
  const round: Round = {
    id: roundId,
    date: `${base.year}-06-09`,
    status,
    isLocked: opts.isLocked ?? status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: base.siteId, name: "Milk Hill", parkingW3W: "filled.count.soap", briefingW3W: "brief.count.soap", takeOffW3W: "takeoff.count.soap" },
    organisingClub: { id: base.clubId, name: "Test Club" },
    season: { year: base.year },
    teams: [{
      id: teamId,
      teamName: "Alpha",
      club: { id: base.clubId, name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: status === "Complete" || status === "Locked",
        signToFly: status === "Complete" || status === "Locked",
        noScore: false,
        pilotPoints: opts.complete ? opts.flightDistance ?? 42 : 0,
        pilotId: base.pilotId,
        snapshot: status === "Locked" || status === "Complete" ? { wingClass: "EN B", pilotRating: "Pilot" } : null,
        flight: status === "Locked" || status === "Complete" ? {
          id: randomUUID(),
          distance: opts.flightDistance ?? 42,
          scoringType: "XC",
          score: 0,
          wingFactor: 1,
          isManualLog: false,
        } : null,
      }],
    }],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePublicJson(`seasons/${base.year}.json`, {
    id: `season-${base.year}`,
    year: base.year,
    active: true,
    rounds: [roundId],
    leagueTable: [],
  } satisfies Season);
  await writePublicJson("rounds.json", [{
    id: roundId,
    date: round.date,
    siteId: base.siteId,
    siteName: "Milk Hill",
    status: round.status,
    seasonYear: base.year,
  }]);
  // Opt-in pre-sign for tests that invoke lockRound directly without first
  // calling signOwnSlot (double-lock race, PureTrack-enqueue-failure). The
  // default path is unchanged so signOwnSlot's 201/200 contract still holds.
  if (opts.preSign === true) {
    for (const team of round.teams) {
      for (const slot of team.pilots) {
        if (slot.status !== "Filled" || !slot.pilotId) continue;
        await writeSignature({
          id: randomUUID(),
          roundId,
          teamId: team.id,
          place: slot.placeInTeam,
          pilotId: slot.pilotId,
          userId: base.adminUserId,
          signedAt: new Date().toISOString(),
          briefVersion: 1,
          briefHash: "lifecycle-fixture-seed-hash",
          wordingVersion: 1,
          wordingHash: "lifecycle-fixture-wording-hash",
          ip: "203.0.113.5",
          userAgent: "lifecycle-fixture",
          source: "pilot-self",
        });
      }
    }
  }
  return { ...base, roundId, teamId };
}

async function seedBaseEntities(opts: { pilotPureTrackId?: number } = {}) {
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const club = await makeClub({ id: randomUUID(), name: "Test Club" });
  await makeClubTeam({ clubId: club.id, clubName: club.name, seasonYear: year, teamName: "Alpha" });
  const site = await makeSite({ id: randomUUID(), name: "Milk Hill", clubId: club.id });
  await writePublicJson(`seasons/${year}.json`, { id: `season-${year}`, year, active: true, rounds: [], leagueTable: [] } satisfies Season);
  await makeConfig({
    wingFactors: {
      "EN A": 1,
      "EN B": 1,
      "EN C": 1,
      "EN C 2-liner": 1,
      "EN D": 1,
      "EN D 2-liner": 1,
    },
  });
  const pilot = await makePilot({ id: randomUUID(), firstName: "Lifecycle", lastName: "Pilot", clubId: club.id });
  const patchedPilot: Pilot = {
    ...pilot,
    pureTrackId: opts.pilotPureTrackId ?? 1234,
    bhpaNumber: 123456,
    helmetColour: "white",
    harnessType: "pod",
    harnessColour: "black",
    wingManufacturer: { id: randomUUID(), name: "Ozone" },
    wingModel: "Delta",
    wingColours: "blue",
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07123456789",
    medicalInfo: "none",
    person: { ...pilot.person, phoneNumber: "07999111222" },
  };
  await writePrivateJson(`pilots/${pilot.id}.json`, patchedPilot);
  await writePublicJson("pilots.json", [{ id: pilot.id, name: pilot.person.fullName, bhpaNumber: 123456, pureTrackId: patchedPilot.pureTrackId }]);
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });
  const { user: pilotUser } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id, clubId: club.id });
  await seedWording();
  return {
    year,
    clubId: club.id,
    siteId: site.id,
    pilotId: pilot.id,
    adminUserId: admin.id,
    adminEmail: admin.email,
    pilotUserId: pilotUser.id,
    pilotEmail: pilotUser.email,
  };
}

async function seedLockedScorableRound(opts: { complete?: boolean } = {}): Promise<LifecycleContext> {
  return seedLifecycleRound({ status: opts.complete ? "Complete" : "Locked", isLocked: !opts.complete, complete: opts.complete, flightDistance: 42 });
}

async function seedWording(): Promise<void> {
  const markdown = "Sign to fly wording";
  await writePrivateJson("sign-to-fly/wording/1.json", {
    version: 1,
    hash: createHash("sha256").update(markdown, "utf8").digest("hex"),
    markdown,
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  } satisfies SignToFlyWording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

async function seedBrief(ctx: LifecycleContext, overrides: Partial<RoundBrief> = {}): Promise<void> {
  await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx, overrides));
}

function makeBrief(ctx: LifecycleContext, overrides: Partial<RoundBrief> = {}): RoundBrief & { version: number } {
  const brief: RoundBrief & { version: number } = {
    roundId: ctx.roundId,
    version: 1,
    generatedAt: "2026-06-09T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    windSpeedDirection: "W 10kt",
    teams: [],
    ...overrides,
  };
  // Post-T7 a BriefComplete round always carries a frozen brief, so freeze the
  // material hash here unless a test sets `hash` explicitly — this is what
  // lockRound's T8 material-hash assertion verifies.
  return overrides.hash === undefined ? { ...brief, hash: computeBriefHash(brief) } : brief;
}

function statusTransition(handler: "confirmRound" | "briefCompleteRound", ctx: LifecycleContext) {
  return invoke(handler, makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function lockRound(ctx: LifecycleContext) {
  return invoke("lockRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function completeRound(ctx: LifecycleContext) {
  return invoke("completeRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function unlockRound(ctx: LifecycleContext) {
  return invoke("unlockRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function cancelRound(ctx: LifecycleContext) {
  return invoke("cancelRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function uncancelRound(ctx: LifecycleContext) {
  return invoke("uncancelRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { id: ctx.roundId },
  }));
}

function updateRoundMeta(ctx: LifecycleContext, body: Record<string, unknown>) {
  return invoke("updateRound", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "PUT",
    params: { id: ctx.roundId },
    body,
  }));
}

function signOwnSlot(ctx: LifecycleContext, caller: { userId: string; email: string } = { userId: ctx.pilotUserId, email: ctx.pilotEmail }) {
  return invoke("signOwnSlot", makeAuthRequest(caller.userId, caller.email, {
    method: "POST",
    params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
    headers: {
      "x-forwarded-for": "10.0.0.1, 203.0.113.42",
      "user-agent": "round-lifecycle-test",
    },
  }));
}

function overrideSign(ctx: LifecycleContext, reason: string) {
  return invoke("overrideSlotSignature", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "POST",
    params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
    body: { reason, onBehalfOfPilotId: ctx.pilotId },
    headers: {
      "x-forwarded-for": "10.0.0.1, 203.0.113.43",
      "user-agent": "round-lifecycle-override-test",
    },
  }));
}

function updateBrief(ctx: LifecycleContext, brief: RoundBrief) {
  return invoke("updateRoundBrief", makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
    method: "PUT",
    params: { id: ctx.roundId },
    body: brief,
  }));
}

async function waitForPublicBlob(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await publicBlobExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function readPublicBytes(path: string): Promise<Buffer> {
  const response = await getPublicContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listPrivateBlobNames(prefix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    names.push(item.name);
  }
  return names;
}

async function readAuditLines(): Promise<Array<Record<string, unknown>>> {
  const path = `audit/sign-override-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const response = await getPrivateContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
