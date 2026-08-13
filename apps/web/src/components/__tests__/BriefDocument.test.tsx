// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { RoundBrief } from "@bccweb/types";
import { BriefDocument } from "../BriefDocument.js";

vi.mock("../BriefImages.js", () => ({
  BriefImages: () => null,
}));

describe("BriefDocument PureTrack links", () => {
  it("uses canonical links for the round and teams", () => {
    const brief: RoundBrief = {
      roundId: "round-1",
      generatedAt: "2026-08-13T12:00:00.000Z",
      date: "2026-08-16",
      siteName: "Avon",
      pureTrackGroupName: "Round group",
      pureTrackGroupSlug: "round-group",
      teams: [{
        teamName: "Alpha",
        clubName: "Club",
        pureTrackGroupSlug: "team-group",
        pilots: [],
      }],
    };

    render(
      <MemoryRouter>
        <BriefDocument brief={brief} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Round group" })).toHaveAttribute(
      "href",
      "https://puretrack.io/g/round-group",
    );
    expect(screen.getByRole("link", { name: "PureTrack ↗" })).toHaveAttribute(
      "href",
      "https://puretrack.io/g/team-group",
    );
  });
});
