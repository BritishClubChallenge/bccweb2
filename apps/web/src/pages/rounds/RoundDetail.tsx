// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router";
import type { Round, PilotSummary, RoundBrief } from "@bccweb/types";
import { useBlob } from "../../hooks/useBlob.js";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { LoadingSpinner, ErrorMessage } from "../../components/LoadingSpinner.js";
import { IgcUploadButton } from "./components/IgcUploadButton.js";
import { CoordIgcTable } from "./components/CoordIgcTable.js";
import { RescoreRoundButton } from "./components/RescoreRoundButton.js";

type BriefWithVersion = RoundBrief & { version?: number };

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function fmt(val?: string) {
  return val ?? "—";
}

interface PilotNameProps {
  pilotId: string | null;
  index: PilotSummary[] | null;
}

function PilotName({ pilotId, index }: PilotNameProps) {
  if (!pilotId) return <span style={{ color: "#aaa" }}>Empty</span>;
  const found = index?.find((p) => p.id === pilotId);
  if (!found) return <span style={{ fontFamily: "monospace", fontSize: "0.8em" }}>{pilotId}</span>;
  return (
    <Link to={`/pilots/${found.id}`} style={{ color: "#0066cc", textDecoration: "none" }}>
      {found.name}
    </Link>
  );
}

export default function RoundDetail() {
  const { id } = useParams<{ id: string }>();
  const { identity } = useAuth();

  const [round, setRound] = useState<Round | null>(null);
  const [brief, setBrief] = useState<BriefWithVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [unregistering, setUnregistering] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);

  const [ptPollCount, setPtPollCount] = useState(0);
  const [ptPollTimeout, setPtPollTimeout] = useState<number | null>(null);

  const loadRound = useCallback((opts?: { silent?: boolean }) => {
    if (!id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Silent refresh (post-mutation reload) must NOT toggle `loading`: the
    // early-return spinner would unmount the round subtree and destroy transient
    // child UI (e.g. the rescore success modal) before it paints.
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
      setNotFound(false);
    }

    Promise.all([
      api.get<Round>(`rounds/${id}`),
      api.get<BriefWithVersion>(`rounds/${id}/brief`).catch((err: unknown) => {
        // Brief is optional: a not-yet-registered pilot (403) or a Proposed
        // round with no brief yet (404) must still see the round + Register.
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
        throw err;
      }),
    ])
      .then(([roundData, briefData]) => {
        if (!cancelled) {
          setRound(roundData);
          setBrief(briefData);
          if (!opts?.silent) setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (opts?.silent) {
            // Mutation already succeeded — surface a failed background reload
            // inline instead of unmounting the page.
            setActionError(err as Error);
          } else {
            setLoading(false);
            setError(err as Error);
            setNotFound(err instanceof ApiError && err.status === 404);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    return loadRound();
  }, [loadRound]);

  useEffect(() => {
    const ptActive = round?.pureTrack?.status === "pending" || round?.pureTrack?.status === "processing";

    let doPoll = false;
    if (ptActive) {
      if (ptPollCount >= 15 && ptPollTimeout === null) setPtPollTimeout(Date.now());
      else if (ptPollCount < 15) doPoll = true;
    } else {
      if (ptPollCount > 0) {
        setPtPollCount(0);
        setPtPollTimeout(null);
      }
    }

    if (!doPoll || !id) return;

    let cancelled = false;
    const delay = Math.min(3000 * Math.pow(1.5, ptPollCount), 15000);
    const timer = setTimeout(() => {
      api.get<Round>(`rounds/${id}`)
        .then((roundData) => {
          if (!cancelled) {
            setRound(roundData);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.warn("PureTrack poll round fetch failed", err);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPtPollCount((c) => c + 1);
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [round?.pureTrack?.status, ptPollCount, ptPollTimeout, id]);

  const { data: pilotsIndex } = useBlob<PilotSummary[]>("pilots.json");

  const isAdmin = identity?.roles.includes("Admin") ?? false;
  const isCoordRole = identity?.roles.includes("RoundsCoord") ?? false;
  const canManage =
    isAdmin ||
    (isCoordRole && identity?.clubId != null && identity.clubId === round?.organisingClub?.id);
  const canRegisterTeams = isAdmin || (isCoordRole && identity?.clubId != null);

  const isPilot = identity?.roles.includes("Pilot") && !!identity.pilotId;

  async function unregisterSelf() {
    if (!round) return;
    const confirmed = window.confirm("Unregister from this round?");
    if (!confirmed) return;

    setUnregistering(true);
    setActionError(null);
    try {
      await api.post(`rounds/${round.id}/unregister-self`, {});
      loadRound({ silent: true });
    } catch (err) {
      setActionError(err as Error);
    } finally {
      setUnregistering(false);
    }
  }

  async function toggleAccounted(teamId: string, place: number, current: boolean) {
    if (!round) return;
    const key = `${teamId}:${place}`;
    setAccountBusy(key);
    setActionError(null);
    try {
      await api.put(`rounds/${round.id}/teams/${teamId}/pilots/${place}/accounted`, {
        accountedFor: !current,
      });
      loadRound({ silent: true });
    } catch (err) {
      setActionError(err as Error);
    } finally {
      setAccountBusy((cur) => (cur === key ? null : cur));
    }
  }

  if (loading) return <LoadingSpinner message="Loading round…" />;
  if (notFound) return <p>Round not found.</p>;
  if (error) return <ErrorMessage error={error} title="Could not load round" />;
  if (!round) return null;

  const registrationOpen = round.status === "Proposed" || round.status === "Confirmed";
  const pilotSlot = isPilot
    ? round.teams.flatMap((team) => team.pilots.map((slot) => ({ team, slot })))
        .find(({ slot }) => slot.status === "Filled" && slot.pilotId === identity?.pilotId)
    : undefined;
  const eligibleTeams = isPilot
    ? round.teams.filter((team) => !identity?.clubId || team.club.id === identity.clubId)
    : [];
  const canRegister = isPilot && registrationOpen && !pilotSlot && eligibleTeams.length > 0;
  const canUnregister = isPilot && registrationOpen && pilotSlot && !pilotSlot.slot.signToFly;
  const signedSlot = isPilot && pilotSlot?.slot.signToFly;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* ── Breadcrumb ── */}
      <nav style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "#888" }}>
        <Link to="/rounds" style={{ color: "#0066cc", textDecoration: "none" }}>
          Rounds
        </Link>{" "}
        / {round.site.name} — {formatDate(round.date)}
      </nav>

      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.25rem" }}>
            {round.site.name}
          </h1>
          <p style={{ margin: 0, color: "#555" }}>
            {formatDate(round.date)} — {round.season.year} Season
          </p>
        </div>
        <StatusBadge status={round.status} />
        {(canManage || canRegisterTeams) && (
          <Link
            to={`/rounds/${round.id}/manage`}
            style={{
              padding: "0.35rem 0.75rem",
              background: "#e9ecef",
              color: "#333",
              borderRadius: "0.3rem",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            {canManage ? "Manage" : "Register teams"}
          </Link>
        )}
      </div>

      {actionError && <ErrorMessage error={actionError} title="Could not update registration" />}

      {isPilot && (
        <section style={{ marginBottom: "1.5rem", padding: "1rem", border: "1px solid #dee2e6", borderRadius: "0.5rem", background: "#f8f9fa" }}>
          {canRegister && (
            <Link
              to={`/rounds/${round.id}/register`}
              style={{ display: "inline-block", padding: "0.55rem 0.85rem", background: "#0066cc", color: "white", borderRadius: "0.3rem", textDecoration: "none", fontWeight: 700 }}
            >
              Register for this round
            </Link>
          )}
          {canUnregister && (
            <button
              type="button"
              onClick={unregisterSelf}
              disabled={unregistering}
              style={{ padding: "0.55rem 0.85rem", background: "#842029", color: "white", border: 0, borderRadius: "0.3rem", fontWeight: 700, cursor: unregistering ? "wait" : "pointer" }}
            >
              {unregistering ? "Unregistering…" : "Unregister from this round"}
            </button>
          )}
          {signedSlot && (
            <p style={{ margin: 0, color: "#555", fontWeight: 600 }}>
              You have signed — contact a coordinator to be removed.
            </p>
          )}
          {isPilot && !canRegister && !canUnregister && !signedSlot && registrationOpen && pilotSlot && (
            <p style={{ margin: 0, color: "#555" }}>You are registered for this round.</p>
          )}
        </section>
      )}

      {/* ── Round Info ── */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "0.75rem",
          marginBottom: "2rem",
          padding: "1rem",
          background: "#f8f9fa",
          borderRadius: "0.5rem",
        }}
      >
        {brief?.briefingTime && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Briefing</dt>
            <dd style={{ margin: 0, fontWeight: 500 }}>{brief.briefingTime}</dd>
          </div>
        )}
        {brief?.checkInByTime && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Check-in by</dt>
            <dd style={{ margin: 0, fontWeight: 500 }}>{brief.checkInByTime}</dd>
          </div>
        )}
        {brief?.landByTime && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Land by</dt>
            <dd style={{ margin: 0, fontWeight: 500 }}>{brief.landByTime}</dd>
          </div>
        )}
        {round.organisingClub && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Organising Club</dt>
            <dd style={{ margin: 0 }}>{round.organisingClub.name}</dd>
          </div>
        )}
        <div>
          <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Max Teams</dt>
          <dd style={{ margin: 0 }}>{round.maxTeams}</dd>
        </div>
        {round.site.parkingW3W && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Parking (W3W)</dt>
            <dd style={{ margin: 0, fontFamily: "monospace", fontSize: "0.85em" }}>
              {round.site.parkingW3W}
            </dd>
          </div>
        )}
        {round.site.takeOffW3W && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>Take-off (W3W)</dt>
            <dd style={{ margin: 0, fontFamily: "monospace", fontSize: "0.85em" }}>
              {round.site.takeOffW3W}
            </dd>
          </div>
        )}
        {(round.pureTrack?.status || (round.pureTrackGroupName && round.pureTrackGroupName !== "Not set yet...")) && (
          <div>
            <dt style={{ fontSize: "0.75rem", color: "#888", fontWeight: 600 }}>PureTrack Group</dt>
            <dd style={{ margin: 0, fontSize: "0.85em", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {(round.pureTrack?.status === "pending" || round.pureTrack?.status === "processing") ? (
                ptPollTimeout ? (
                  <>
                    <span style={{ color: "#666" }}>Still {round.pureTrack.status === "pending" ? "queued" : "creating"}…</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!id) return;
                        api.get<Round>(`rounds/${id}`)
                          .then((roundData) => setRound(roundData))
                          .catch((err: unknown) => setActionError(err as Error))
                          .finally(() => {
                            setPtPollCount(0);
                            setPtPollTimeout(null);
                          });
                      }}
                      style={{ padding: "0.2rem 0.5rem", fontSize: "0.7rem", background: "#f1f3f5", border: "1px solid #ccc", borderRadius: "0.2rem", cursor: "pointer" }}
                    >
                      Refresh
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #dee2e6", borderTopColor: "currentColor", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    <span style={{ color: "#666" }}>{round.pureTrack.status === "pending" ? "Queued…" : "Creating…"}</span>
                  </>
                )
              ) : round.pureTrack?.status === "failed" ? (
                <span style={{ color: "#d32f2f" }}>Creation failed</span>
              ) : round.pureTrackGroupSlug ? (
                <a
                  href={`https://puretrack.io/g/${round.pureTrackGroupSlug}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#0066cc" }}
                >
                  {round.pureTrackGroupName}
                </a>
              ) : round.pureTrackGroupName ? (
                round.pureTrackGroupName
              ) : (
                <span style={{ color: "#888" }}>No groups (none created)</span>
              )}
            </dd>
          </div>
        )}
      </section>



      {/* ── Teams ── */}
      {round.teams.length > 0 && (
        <section>
          <h2 style={{ fontSize: "1.1rem" }}>
            Teams ({round.teams.length})
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: "1rem",
            }}
          >
            {round.teams
              .slice()
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .map((team) => (
                <div
                  key={team.id}
                  style={{
                    border: "1px solid #dee2e6",
                    borderRadius: "0.5rem",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.6rem 0.8rem",
                      background: "#f8f9fa",
                      borderBottom: "1px solid #dee2e6",
                    }}
                  >
                    <div>
                      <strong>{team.teamName}</strong>
                      <span style={{ marginLeft: "0.5rem", color: "#888", fontSize: "0.85em" }}>
                        {team.club.name}
                      </span>
                      {team.captainPilotId && (
                        <div style={{ fontSize: "0.78rem", color: "#555", marginTop: "0.2rem" }}>
                          Captain:{" "}
                          <strong>
                            {pilotsIndex?.find((p) => p.id === team.captainPilotId)?.name
                              ?? team.captainPilotId}
                          </strong>
                        </div>
                      )}
                    </div>
                    {team.score > 0 && (
                      <span style={{ fontWeight: 700, color: "#0a3622" }}>
                        {team.score}
                      </span>
                    )}
                  </div>
                  <table
                    style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}
                  >
                    <tbody>
                      {team.pilots
                        .filter((slot) => slot.status === "Filled" || slot.flight !== null)
                        .map((slot) => (
                          <tr
                            key={slot.placeInTeam}
                            style={{ borderBottom: "1px solid #f5f5f5" }}
                          >
                            <td
                              style={{
                                padding: "0.35rem 0.5rem",
                                color: slot.isScoring ? "#333" : "#888",
                                width: "24px",
                                textAlign: "center",
                                fontSize: "0.75em",
                              }}
                            >
                              {slot.placeInTeam}
                            </td>
                            <td style={{ padding: "0.35rem 0.5rem" }}>
                              <PilotName pilotId={slot.pilotId} index={pilotsIndex} />
                              {slot.noScore && (
                                <span
                                  style={{
                                    marginLeft: "0.4rem",
                                    fontSize: "0.75em",
                                    color: "#888",
                                  }}
                                >
                                  (NS)
                                </span>
                              )}
                              {identity?.roles.includes("Pilot") && slot.pilotId === identity.pilotId && round.status === "BriefComplete" && (
                                <div style={{ marginTop: "0.4rem" }}>
                                  {!slot.signToFly ? (
                                    <Link
                                      to={`/rounds/${round.id}/sign/${team.id}/${slot.placeInTeam}`}
                                      style={{
                                        display: "inline-block",
                                        padding: "0.25rem 0.5rem",
                                        background: "#0066cc",
                                        color: "white",
                                        borderRadius: "0.2rem",
                                        textDecoration: "none",
                                        fontWeight: 600,
                                        fontSize: "0.75rem",
                                      }}
                                    >
                                      Sign to Fly
                                    </Link>
                                  ) : brief?.version ? (
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "0.15rem 0.4rem",
                                        background: "#e9ecef",
                                        color: "#555",
                                        borderRadius: "0.2rem",
                                        fontSize: "0.7rem",
                                        fontWeight: 500,
                                      }}
                                    >
                                      Signed for brief v{brief.version}
                                    </span>
                                  ) : null}
                                </div>
                              )}
                              {round.status === "Locked" &&
                                slot.status === "Filled" &&
                                slot.pilotId === identity?.pilotId && (
                                  <div data-testid="my-slot">
                                    <IgcUploadButton
                                      roundId={round.id}
                                      teamId={team.id}
                                      place={slot.placeInTeam}
                                      currentFlight={slot.flight ?? null}
                                      onUploaded={() => {
                                        loadRound({ silent: true });
                                      }}
                                    />
                                  </div>
                                )}
                              {round.status === "Locked" &&
                                slot.status === "Filled" &&
                                (canManage ||
                                  (!!identity?.pilotId &&
                                    team.captainPilotId === identity.pilotId) ||
                                  (!!identity?.pilotId &&
                                    slot.pilotId === identity.pilotId)) && (
                                  <div style={{ marginTop: "0.4rem" }}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void toggleAccounted(
                                          team.id,
                                          slot.placeInTeam,
                                          slot.accountedFor,
                                        );
                                      }}
                                      disabled={
                                        accountBusy === `${team.id}:${slot.placeInTeam}`
                                      }
                                      style={{
                                        display: "inline-block",
                                        padding: "0.25rem 0.5rem",
                                        background: slot.accountedFor ? "#d1e7dd" : "#e9ecef",
                                        color: slot.accountedFor ? "#0a3622" : "#555",
                                        border: 0,
                                        borderRadius: "0.2rem",
                                        fontWeight: 600,
                                        fontSize: "0.75rem",
                                        cursor: "pointer",
                                      }}
                                    >
                                      {slot.accountedFor
                                        ? "✓ Accounted for"
                                        : "Mark accounted for"}
                                    </button>
                                  </div>
                                )}
                            </td>
                            <td
                              style={{
                                padding: "0.35rem 0.5rem",
                                textAlign: "right",
                                color: "#555",
                                fontSize: "0.85em",
                              }}
                            >
                              {slot.flight ? (
                                <span>
                                  {slot.flight.distance} km
                                  {slot.flight.score > 0 && (
                                    <span
                                      title="Handicap score (distance × pilot factor × wing factor), before round normalisation"
                                      style={{ marginLeft: "0.4rem", fontWeight: 600, color: "#0a3622" }}
                                    >
                                      ({slot.flight.score.toFixed(1)})
                                    </span>
                                  )}
                                </span>
                              ) : fmt(undefined)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        </section>
      )}

      {canManage && <CoordIgcTable round={round} onChanged={() => loadRound({ silent: true })} />}
      <RescoreRoundButton round={round} onChanged={() => loadRound({ silent: true })} />
    </div>
  );
}
