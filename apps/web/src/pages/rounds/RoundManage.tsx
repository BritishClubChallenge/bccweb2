// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState, useCallback, useEffect } from "react";
import { Link, useParams } from "react-router";
import type { Round, PilotSummary, ClubSummary, ClubTeamSummary } from "@bccweb/types";
import { isRosterFrozen, rosterFrozenReason } from "@bccweb/types";
import { api, ApiError } from "../../lib/api.js";
import { useAuth } from "../../hooks/useAuth.js";
import { useBlob } from "../../hooks/useBlob.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { ErrorMessage } from "../../components/LoadingSpinner.js";
import { sectionStyle } from "./RoundManage.shared.js";
import { MetadataForm } from "./RoundMetadataForm.js";
import { BriefForm } from "./RoundBriefForm.js";
import { RoundWorkflowActions } from "./RoundWorkflowActions.js";
import { RoundTeamsList } from "./RoundTeamsList.js";
import { RoundManageHeader } from "./RoundManageHeader.js";

export default function RoundManage() {
  const { id } = useParams<{ id: string }>();
  const { identity, loading: authLoading } = useAuth();

  const [round, setRound] = useState<Round | null>(null);
  const [roundLoading, setRoundLoading] = useState(true);
  const [roundError, setRoundError] = useState<Error | null>(null);
  const [notFound, setNotFound] = useState(false);

  const { data: pilotsIndex } = useBlob<PilotSummary[]>("pilots.json");
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json");
  const { data: clubTeams } = useBlob<ClubTeamSummary[]>("club-teams.json");

  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ label: string; endpoint: string; count: number } | null>(null);

  const [pollCount, setPollCount] = useState(0);
  const [pollTimeout, setPollTimeout] = useState<number | null>(null);

  const [ptPollCount, setPtPollCount] = useState(0);
  const [ptPollTimeout, setPtPollTimeout] = useState<number | null>(null);

  const loadRound = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<Round>(`rounds/${id}`);
      setRound(r);
      setRoundError(null);
      setNotFound(false);
    } catch (err: unknown) {
      setRoundError(err as Error);
      setNotFound(err instanceof ApiError && err.status === 404);
    }
  }, [id]);

  // Initial load
  useEffect(() => {
    if (!id) {
      setRoundLoading(false);
      return;
    }
    let cancelled = false;
    setRoundLoading(true);
    setRoundError(null);
    setNotFound(false);

    api
      .get<Round>(`rounds/${id}`)
      .then((data) => {
        if (!cancelled) {
          setRound(data);
          setRoundLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoundLoading(false);
          setRoundError(err as Error);
          setNotFound(err instanceof ApiError && err.status === 404);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const pdfActive = round?.brief?.pdfStatus === "pending" || round?.brief?.pdfStatus === "processing";
    const ptActive = round?.pureTrack?.status === "pending" || round?.pureTrack?.status === "processing";

    if (!pdfActive && !ptActive) {
      if (pollCount > 0) {
        setPollCount(0);
        setPollTimeout(null);
      }
      if (ptPollCount > 0) {
        setPtPollCount(0);
        setPtPollTimeout(null);
      }
      return;
    }

    let doPoll = false;
    if (pdfActive) {
      if (pollCount >= 15 && pollTimeout === null) setPollTimeout(Date.now());
      else if (pollCount < 15) doPoll = true;
    } else {
      if (pollCount > 0) {
        setPollCount(0);
        setPollTimeout(null);
      }
    }

    if (ptActive) {
      if (ptPollCount >= 15 && ptPollTimeout === null) setPtPollTimeout(Date.now());
      else if (ptPollCount < 15) doPoll = true;
    } else {
      if (ptPollCount > 0) {
        setPtPollCount(0);
        setPtPollTimeout(null);
      }
    }

    if (!doPoll) return;

    const maxCount = Math.max(pdfActive ? pollCount : 0, ptActive ? ptPollCount : 0);
    const delay = Math.min(3000 * Math.pow(1.5, maxCount), 15000);
    const timer = setTimeout(() => {
      void loadRound().finally(() => {
        if (pdfActive) setPollCount((c) => c + 1);
        if (ptActive) setPtPollCount((c) => c + 1);
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [round?.brief?.pdfStatus, round?.pureTrack?.status, pollCount, pollTimeout, ptPollCount, ptPollTimeout, loadRound]);

  async function regeneratePdf() {
    if (!round) return;
    await runAction("Regenerate PDF", () => api.post(`rounds/${round.id}/brief/regenerate`));
    setPollCount(0);
    setPollTimeout(null);
  }

  async function recreatePureTrack() {
    if (!round) return;
    await runAction("Recreate PureTrack Groups", () => api.post(`rounds/${round.id}/puretrack/create-groups`));
    setPtPollCount(0);
    setPtPollTimeout(null);
  }

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setActionErr(null);
    setActionBusy(label);
    try {
      await fn();
      await loadRound();
    } catch (ex) {
      setActionErr(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Action failed");
    } finally {
      setActionBusy(null);
    }
  }

  // Auth gate
  const isCoord =
    identity?.roles.includes("RoundsCoord") ||
    identity?.roles.includes("Admin");

  if (authLoading || roundLoading) return <LoadingSpinner message="Loading…" />;
  if (!identity || !isCoord) {
    return (
      <div style={{ maxWidth: 500, margin: "2rem auto" }}>
        <p style={{ color: "#721c24" }}>
          You must be signed in as a Rounds Coordinator or Admin.
        </p>
      </div>
    );
  }
  if (notFound) return <p>Round not found.</p>;
  if (roundError) return <ErrorMessage error={roundError} title="Could not load round" />;
  if (!round) return null;

  const r = round;
  const myClubId = identity.clubId ?? null;
  const isAdmin = identity.roles.includes("Admin");
  const isRoundsCoord = identity.roles.includes("RoundsCoord");
  
  const canManage = isAdmin || (isRoundsCoord && myClubId !== null && myClubId === r.organisingClub?.id);
  const canOverrideSign = r.status === "BriefComplete" && canManage;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Breadcrumb */}
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/rounds" style={{ color: "#0066cc", textDecoration: "none" }}>
          Rounds
        </Link>{" "}
        /{" "}
        <Link to={`/rounds/${r.id}`} style={{ color: "#0066cc", textDecoration: "none" }}>
          {r.site.name}
        </Link>{" "}
        / Manage
      </nav>

      {/* Header */}
      <RoundManageHeader
        r={r}
        canManage={canManage}
        pollTimeout={pollTimeout}
        ptPollTimeout={ptPollTimeout}
        regeneratePdf={() => void regeneratePdf()}
        recreatePureTrack={() => void recreatePureTrack()}
      />
      {r.status === "Cancelled" && (
        <div style={{ ...sectionStyle, background: "#f8d7da", color: "#58151c", border: "1px solid #f5c2c7" }}>
          <strong>This round is cancelled.</strong> No changes can be made while it is cancelled. Use <strong>Uncancel</strong> to reopen it as Proposed.
        </div>
      )}

      {/* Workflow actions */}
      <RoundWorkflowActions
        roundId={r.id}
        status={r.status}
        canManage={canManage}
        canOverrideSign={canOverrideSign}
        actionBusy={actionBusy}
        actionErr={actionErr}
        confirmModal={confirmModal}
        setActionErr={setActionErr}
        setActionBusy={setActionBusy}
        setConfirmModal={setConfirmModal}
        runAction={runAction}
        recreatePureTrack={() => void recreatePureTrack()}
      />
      {/* Metadata */}
      {canManage && (
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Round Details</h2>
          {r.status === "Cancelled" ? (
            <p style={{ color: "#888", fontSize: "0.85rem", margin: 0 }}>
              This round is cancelled. Uncancel it to edit.
            </p>
          ) : isRosterFrozen(r.status) ? (
            <p style={{ color: "#888", fontSize: "0.85rem", margin: 0 }}>
              Round details cannot be edited while {rosterFrozenReason(r.status)}.
            </p>
          ) : (
            <MetadataForm round={r} onSaved={() => { void loadRound(); }} />
          )}
        </section>
      )}

      {/* Brief Form */}
      {canManage && (
        <section style={sectionStyle}>
          <BriefForm round={r} onSaved={() => { void loadRound(); }} />
        </section>
      )}

      {/* Teams */}
      <RoundTeamsList
        r={r}
        pilotsIndex={pilotsIndex ?? null}
        clubs={clubs ?? null}
        clubTeams={clubTeams ?? null}
        canManage={canManage}
        canOverrideSign={canOverrideSign}
        isRoundsCoord={isRoundsCoord}
        isAdmin={isAdmin}
        myClubId={myClubId}
        loadRound={loadRound}
      />
    </div>
  );
}
