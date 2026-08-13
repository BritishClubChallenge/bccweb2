// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import type { RoundBrief } from "@bccweb/types";
import { renderBriefPdfHtml } from "../pdf.js";
// Shared XSS corpus (9 payloads) — path from apps/api test dir, .js extension (NodeNext).
import { XSS_CORPUS } from "../../../../../tests/fixtures/xss-corpus.js";

function brief(overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: "round-1",
    generatedAt: "2026-06-09T09:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    teams: [],
    ...overrides,
  };
}

// The three markdown prose fields that switch to sanitised triple-mustache.
const PROSE_FIELDS = [
  "briefersNotes",
  "airspaceAndHazards",
  "expectedLandingArea",
] as const satisfies readonly (keyof RoundBrief)[];

describe("brief PDF safety fields", () => {
  it("uses canonical PureTrack links for the round and teams", () => {
    const html = renderBriefPdfHtml(brief({
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [{
        teamName: "Alpha",
        clubName: "Club",
        pureTrackGroupSlug: "team-group",
        pilots: [],
      }],
    }));

    expect(html).toContain('href="https://puretrack.io/g/round-group"');
    expect(html).toContain('href="https://puretrack.io/g/team-group"');
  });

  it("includes safety labels", () => {
    const html = renderBriefPdfHtml(brief({
      NOTAMs: "Glider competition nearby",
      airspaceAndHazards: "Avoid CTA",
      expectedLandingArea: "North field",
      windSpeedDirection: "12kt SW",
      directionOfFlight: "East",
      BENO_LineDescription: "Do not cross ridge line",
      briefersNotes: "Watch sea breeze",
    }));

    expect(html).toContain("NOTAMs");
    expect(html).toContain("Airspace &amp; Hazards");
    expect(html).toContain("Expected Landing Area");
    expect(html).toContain("Wind Speed &amp; Direction");
    expect(html).toContain("Direction of Flight");
    expect(html).toContain("BENO Line Description");
    expect(html).toContain("Briefer's Notes");
  });

  it("renders missing fields as Not provided", () => {
    const html = renderBriefPdfHtml(brief());

    expect(html).toContain("Not provided");
  });

  it("renders briefer contact block when present", () => {
    const html = renderBriefPdfHtml(brief({
      briefer: {
        name: "Alex Briefer",
        bhpaCoachLevel: "SeniorCoach",
        phoneNumber: "07123 456789",
        emailAddress: "alex@example.com",
      },
    }));

    expect(html).toContain("Alex Briefer");
    expect(html).toContain("Senior Coach");
    expect(html).toContain("07123 456789");
    expect(html).toContain("alex@example.com");
  });
});

describe("brief PDF markdown sanitisation (prose fields)", () => {
  // R1: every shared-corpus payload must be neutralised in the rendered HTML.
  it.each(XSS_CORPUS)("neutralises XSS payload in briefersNotes: %j", (payload) => {
    const html = renderBriefPdfHtml(brief({ briefersNotes: payload }));

    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/onload/i);
    expect(html).not.toMatch(/onmouseover/i);
  });

  // Each prose field is sanitised independently (not just briefersNotes).
  it.each(PROSE_FIELDS)("neutralises the onerror payload in field %s", (field) => {
    const payload = "<img src=x onerror=alert(1)>";
    const html = renderBriefPdfHtml(brief({ [field]: payload }));

    expect(html).not.toMatch(/onerror/i);
  });

  // R1 positive render: markdown is actually rendered, not just stripped.
  it.each(PROSE_FIELDS)("renders **bold** markdown to <strong> in field %s", (field) => {
    const html = renderBriefPdfHtml(brief({ [field]: "**bold**" }));

    expect(html).toContain("<strong>");
    expect(html).toContain("bold");
  });

  it("drops ALL prose-markdown images (SSRF hardening) plus the onerror payload", () => {
    // Prose is rendered by Chromium server-side, so <img> is forbidden — an
    // attacker-controlled src must never trigger an outbound fetch. Brief images
    // use the separate authenticated pipeline, never inline prose markdown.
    const html = renderBriefPdfHtml(brief({ briefersNotes: "![x](x) <img src=x onerror=alert(1)>" }));

    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("<img");
  });

  it("keeps non-prose fields HTML-escaped (double-mustache), not markdown-rendered", () => {
    const html = renderBriefPdfHtml(brief({
      NOTAMs: "<script>alert('notam')</script>",
      windSpeedDirection: "<b>12kt</b>",
      directionOfFlight: "**east**",
    }));

    // Escaped, never executed / rendered as HTML.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;b&gt;12kt&lt;/b&gt;");
    // A non-prose field must NOT run through marked: literal ** stays as text.
    expect(html).toContain("**east**");
  });

  // R2: bounded heap on reused/long-lived Azure Functions hosts. isomorphic-dompurify
  // uses ONE process-lifetime jsdom window (NOT one-per-PDF), so reusing it is the
  // memory-bounding choice. Measured (task-11 evidence): a clearWindow()-per-render
  // "teardown" is ~6.6x WORSE — jsdom retains each closed window shell — growing heap to
  // ~56 MB over 50 renders; the singleton path is ~8.5 MB (forced GC) / ~0 (natural GC).
  // Real briefs sanitise <=3 prose fields and each spawns Chromium (which dwarfs jsdom),
  // so 50 renders x 3 fields is far beyond real volume. This asserts the efficient path
  // and fails a clearWindow-per-render regression.
  it("bounds heapUsed across a 50-call sanitising render loop (singleton window, no churn)", () => {
    const md =
      "# Brief\n\n**bold** _em_ `code`\n\n- one\n- two\n\n<img src=x onerror=alert(1)> [l](javascript:alert(1))";

    const sample = (): number => {
      globalThis.gc?.();
      return process.memoryUsage().heapUsed;
    };

    // Warm up: module init, jsdom window, marked/handlebars internal caches.
    for (let i = 0; i < 5; i += 1) {
      renderBriefPdfHtml(brief({ briefersNotes: md, airspaceAndHazards: md, expectedLandingArea: md }));
    }

    const before = sample();
    for (let i = 0; i < 50; i += 1) {
      const html = renderBriefPdfHtml(
        brief({ briefersNotes: md, airspaceAndHazards: md, expectedLandingArea: md }),
      );
      // Still sanitising on every iteration (guards against a helper no-op regression).
      expect(html).not.toMatch(/onerror/i);
    }
    const after = sample();

    const growthMb = (after - before) / 1024 / 1024;
    console.log(`[pdf memory] 50-render heapUsed growth: ${growthMb.toFixed(2)} MB`);

    // Passes the singleton path (~8.5 MB forced GC / ~0 natural GC) with headroom; a
    // per-render clearWindow() regression (~56 MB) blows past this and fails.
    expect(growthMb).toBeLessThan(40);
  });
});
