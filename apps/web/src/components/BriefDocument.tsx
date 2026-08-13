// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { Link } from "react-router";
import { MarkdownView } from "./MarkdownView.js";
import { BriefImages } from "./BriefImages.js";
import { coachLabel } from "../lib/coach.js";
import type {
  RoundBrief as RoundBriefType,
  BriefTeamEntry,
  BriefPilotEntry,
  ManufacturerRef,
} from "@bccweb/types";

function w3wUrl(w3w?: string) {
  if (!w3w) return null;
  const clean = w3w.replace(/^\/\/\//, "");
  return `https://what3words.com/${clean}`;
}

function displayValue(value?: string) {
  return value?.trim() ? value : "Not provided";
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ManufacturerLink({ manufacturer, model }: { manufacturer?: ManufacturerRef; model?: string }) {
  if (!manufacturer) return <>{model ?? "—"}</>;
  const url = safeExternalUrl(manufacturer.websiteUrl);
  const label = `${manufacturer.name}${model ? ` ${model}` : ""}`;
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0" }}>
      {label}
    </a>
  ) : (
    <>{label}</>
  );
}

const safetyFields: Array<{ label: string; value: (brief: RoundBriefType) => string | undefined; isProse?: boolean }> = [
  { label: "Wind Speed & Direction", value: (brief) => brief.windSpeedDirection },
  { label: "Direction of Flight", value: (brief) => brief.directionOfFlight },
  { label: "Expected Landing Area", value: (brief) => brief.expectedLandingArea, isProse: true },
  { label: "Airspace & Hazards", value: (brief) => brief.airspaceAndHazards, isProse: true },
  { label: "NOTAMs", value: (brief) => brief.NOTAMs },
  { label: "BENO Line Description", value: (brief) => brief.BENO_LineDescription },
  { label: "Briefer's Notes", value: (brief) => brief.briefersNotes, isProse: true },
];

function W3WLink({ value, label }: { value?: string; label: string }) {
  if (!value) return null;
  const url = w3wUrl(value);
  return (
    <div style={{ marginBottom: "0.35rem" }}>
      <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>{label}: </span>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0", fontSize: "0.9rem" }}>
          {value}
        </a>
      ) : (
        <span style={{ fontSize: "0.9rem" }}>{value}</span>
      )}
    </div>
  );
}

function PilotTable({ pilots }: { pilots: BriefPilotEntry[] }) {
  const thStyle: React.CSSProperties = {
    background: "#f0f2f8",
    padding: "0.3rem 0.5rem",
    textAlign: "left",
    fontSize: "0.75rem",
    color: "#444",
    borderBottom: "1px solid #c8cce0",
    whiteSpace: "nowrap",
  };
  const tdStyle: React.CSSProperties = {
    padding: "0.25rem 0.5rem",
    borderBottom: "1px solid #eef0f5",
    fontSize: "0.82rem",
    verticalAlign: "top",
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
        <thead>
          <tr>
            <th style={thStyle}>#</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>BHPA</th>
            <th style={thStyle}>Rating</th>
            <th style={thStyle}>Wing Class</th>
            <th style={thStyle}>Wing</th>
            <th style={thStyle}>Colours</th>
            <th style={thStyle}>Helmet</th>
            <th style={thStyle}>Emergency</th>
            <th style={thStyle}>Medical</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => (
            <tr key={p.pilotId}>
              <td style={tdStyle}>
                {p.placeInTeam}
                {!p.isScoring && (
                  <span style={{ color: "#999", fontStyle: "italic", fontSize: "0.75em" }}> *</span>
                )}
              </td>
              <td style={tdStyle}>
                <Link to={`/pilots/${p.pilotId}`} style={{ color: "#1a4fa0", textDecoration: "none" }}>
                  {p.name}
                </Link>
              </td>
              <td style={{ ...tdStyle, color: "#666" }}>{p.bhpaNumber ?? "—"}</td>
              <td style={tdStyle}>{p.snapshot.pilotRating}</td>
              <td style={tdStyle}>{p.snapshot.wingClass}</td>
              <td style={tdStyle}>
                <ManufacturerLink manufacturer={p.wingManufacturer} model={p.snapshot.wingModel} />
              </td>
              <td style={tdStyle}>{p.snapshot.wingColours ?? "—"}</td>
              <td style={tdStyle}>{p.snapshot.helmetColour ?? "—"}</td>
              <td style={tdStyle}>
                {p.snapshot.emergencyContactName ? (
                  <>
                    {p.snapshot.emergencyContactName}
                    {p.snapshot.emergencyPhoneNumber && (
                      <><br /><span style={{ color: "#666" }}>{p.snapshot.emergencyPhoneNumber}</span></>
                    )}
                  </>
                ) : "—"}
              </td>
              <td style={{ ...tdStyle, color: p.snapshot.medicalInfo ? "#8b0000" : "#999", fontWeight: p.snapshot.medicalInfo ? 700 : 400 }}>
                {p.snapshot.medicalInfo ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.75rem", color: "#888", marginTop: "0.3rem" }}>
        * = non-scoring pilot
      </p>
    </div>
  );
}

function TeamSection({ team }: { team: BriefTeamEntry }) {
  const captain = team.pilots.find((p) => p.placeInTeam === 1);

  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          background: "#e8edf8",
          padding: "0.4rem 0.75rem",
          borderRadius: "4px 4px 0 0",
          marginBottom: 0,
        }}
      >
        <div>
          <strong style={{ fontSize: "1rem" }}>{team.teamName}</strong>
          <span style={{ marginLeft: "0.5rem", color: "#555", fontSize: "0.85rem" }}>
            — {team.clubName}
          </span>
          {captain && (
            <span style={{ marginLeft: "0.75rem", fontSize: "0.8rem", color: "#444" }}>
              Captain: <strong>{captain.name}</strong>
            </span>
          )}
        </div>
        {team.pureTrackGroupSlug && (
          <a
            href={`https://puretrack.io/g/${team.pureTrackGroupSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.8rem", color: "#1a4fa0" }}
          >
            PureTrack ↗
          </a>
        )}
      </div>
      <div
        style={{
          border: "1px solid #c8cce0",
          borderTop: "none",
          borderRadius: "0 0 4px 4px",
          overflow: "hidden",
        }}
      >
        <PilotTable pilots={team.pilots} />
      </div>
    </div>
  );
}

function SafetyBriefingSection({ brief }: { brief: RoundBriefType }) {
  const fieldStyle: React.CSSProperties = {
    padding: "0.65rem",
    border: "1px solid #e3e8f2",
    borderRadius: "0.35rem",
    background: "#fff",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "0.25rem",
    color: "#555",
    fontSize: "0.8rem",
    fontWeight: 700,
  };
  const valueStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    color: "#222",
    fontSize: "0.92rem",
  };

  return (
    <section
      style={{
        marginBottom: "1.5rem",
        padding: "1rem",
        border: "1px solid #dee2e6",
        borderRadius: "0.5rem",
        background: "#fbfcff",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "#1a4fa0" }}>
        Safety Briefing
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "0.75rem",
        }}
      >
        {safetyFields.map((field) => {
          const v = field.value(brief);
          return (
            <div key={field.label} style={fieldStyle}>
              <span style={labelStyle}>{field.label}</span>
              {field.isProse ? (
                v?.trim() ? <MarkdownView markdown={v} /> : <span style={valueStyle}>Not provided</span>
              ) : (
                <span style={valueStyle}>{displayValue(v)}</span>
              )}
            </div>
          );
        })}
      </div>

      <h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.6rem", color: "#1a4fa0" }}>
        Briefer Contact
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "0.5rem 1rem",
        }}
      >
        <div><span style={labelStyle}>Name</span>{displayValue(brief.briefer?.name)}</div>
        <div><span style={labelStyle}>BHPA Coach Level</span>{displayValue(brief.briefer?.bhpaCoachLevel ? coachLabel[brief.briefer.bhpaCoachLevel] : undefined)}</div>
        <div><span style={labelStyle}>BHPA Number</span>{displayValue(brief.briefer?.bhpaNumber)}</div>
        <div><span style={labelStyle}>Phone</span>{displayValue(brief.briefer?.phoneNumber)}</div>
        <div><span style={labelStyle}>Email</span>{displayValue(brief.briefer?.emailAddress)}</div>
      </div>

      <BriefImages imagePaths={brief.imagePaths || []} roundId={brief.roundId} />
    </section>
  );
}

function SiteInformationSection({ brief }: { brief: RoundBriefType }) {
  return (
    <section
      style={{
        marginBottom: "1.5rem",
        padding: "1rem",
        border: "1px solid #dee2e6",
        borderRadius: "0.5rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "#1a4fa0" }}>
        Site Information
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "0.5rem 1.5rem",
        }}
      >
        {brief.briefingTime && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Briefing: </span>
            <span>{brief.briefingTime}</span>
          </div>
        )}
        {brief.checkInByTime && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Check-in By: </span>
            <span>{brief.checkInByTime}</span>
          </div>
        )}
        {brief.landByTime && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Land By: </span>
            <span>{brief.landByTime}</span>
          </div>
        )}
        {brief.pureTrackGroupName && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>PureTrack: </span>
            <a
              href={`https://puretrack.io/g/${brief.pureTrackGroupSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#1a4fa0" }}
            >
              {brief.pureTrackGroupName}
            </a>
          </div>
        )}
        {brief.guideUrl && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Site Guide: </span>
            <a href={brief.guideUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#1a4fa0" }}>
              Open guide ↗
            </a>
          </div>
        )}
        {brief.frequencyMhz !== undefined && (
          <div>
            <span style={{ fontSize: "0.8rem", color: "#666", fontWeight: 600 }}>Frequency: </span>
            <span>{brief.frequencyMhz} MHz</span>
          </div>
        )}
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <W3WLink value={brief.parkingW3W} label="Parking" />
        <W3WLink value={brief.briefingW3W} label="Briefing" />
        <W3WLink value={brief.takeOffW3W} label="Take-off" />
      </div>
    </section>
  );
}

/**
 * Full brief document body (Site Information + Safety Briefing + Teams &
 * Pilots), shared by the RoundBrief view page and the SignToFly signing page.
 * Renders content only — page chrome (header, breadcrumb, PDF button) stays
 * with each page.
 */
export function BriefDocument({ brief }: { brief: RoundBriefType }) {
  return (
    <>
      <SiteInformationSection brief={brief} />
      <SafetyBriefingSection brief={brief} />
      <section>
        <h2 style={{ fontSize: "1rem", margin: "0 0 1rem", color: "#1a4fa0" }}>
          Teams &amp; Pilots ({brief.teams.length} teams)
        </h2>
        {brief.teams.length === 0 ? (
          <p style={{ color: "#888" }}>No teams registered.</p>
        ) : (
          brief.teams.map((team) => <TeamSection key={team.teamName} team={team} />)
        )}
      </section>
    </>
  );
}
