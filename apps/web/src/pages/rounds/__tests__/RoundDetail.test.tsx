// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Round, RescoreJob, RescoreJobCounts, RescoreJobStatus } from "@bccweb/types";
import RoundDetail from "../RoundDetail.js";
import { api, ApiError } from "../../../lib/api.js";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual("../../../lib/api.js");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  };
});

let mockIdentity: {
  userId: string;
  email: string;
  roles: string[];
  pilotId: string | null;
  clubId: string | null;
} | null = null;

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: () => ({ identity: mockIdentity, loading: false, logout: vi.fn() }),
}));

vi.mock("../../../hooks/useBlob.js", () => ({
  useBlob: () => ({
    data: [
      { id: "cap", name: "Cap Tain" },
      { id: "mem", name: "Mem Ber" },
      { id: "oth", name: "Oth Er" },
    ],
    loading: false,
    error: null,
    notFound: false,
  }),
}));

function slot(placeInTeam: number, pilotId: string, accountedFor = false) {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled" as const,
    accountedFor,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: null,
  };
}

function makeRound(status: Round["status"] = "Locked"): Round {
  return {
    id: "r1",
    date: "2026-06-09",
    status,
    isLocked: status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "s1", name: "Milk Hill" },
    organisingClub: { id: "cA", name: "Club A" },
    season: { year: 2026 },
    teams: [
      {
        id: "t1",
        teamName: "Alpha",
        club: { id: "cA", name: "Club A" },
        score: 0,
        captainPilotId: "cap",
        pilots: [slot(1, "cap", true), slot(2, "mem", false)],
      },
      {
        id: "t2",
        teamName: "Bravo",
        club: { id: "cB", name: "Club B" },
        score: 0,
        captainPilotId: "oth",
        pilots: [slot(1, "oth", false)],
      },
    ],
  };
}

function mockLoad(round: Round) {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === "rounds/r1") return Promise.resolve(round) as Promise<unknown>;
    if (path === "rounds/r1/brief") {
      return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/rounds/r1"]}>
      <Routes>
        <Route path="/rounds/:id" element={<RoundDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoundDetail — accounted-for management outside the manage page", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    mockIdentity = null;
  });

  it("team captain sees a toggle for every member of THEIR team, none for other teams", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    const buttons = await screen.findAllByRole("button", { name: /accounted for/i });
    // team1 place1 (already accounted) + team1 place2 (not yet) = 2; team2 excluded
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "✓ Accounted for" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark accounted for" })).toBeInTheDocument();
  });

  it("captain clicking a member's toggle PUTs { accountedFor } to the right slot", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("Locked"));
    vi.mocked(api.put).mockResolvedValue({});

    renderPage();

    const markBtn = await screen.findByRole("button", { name: "Mark accounted for" });
    fireEvent.click(markBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("rounds/r1/teams/t1/pilots/2/accounted", {
        accountedFor: true,
      });
    });
  });

  it("non-captain pilot sees a toggle ONLY for their own slot", async () => {
    mockIdentity = { userId: "u", email: "m@x", roles: ["Pilot"], pilotId: "mem", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    const buttons = await screen.findAllByRole("button", { name: /accounted for/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Mark accounted for");
  });

  it("a pilot not in the round sees no accounted-for toggle", async () => {
    mockIdentity = { userId: "u", email: "z@x", roles: ["Pilot"], pilotId: "zzz", clubId: "cA" };
    mockLoad(makeRound("Locked"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    await waitFor(() => expect(screen.queryByText(/Mark accounted for/i)).not.toBeInTheDocument());
  });

  it("no toggle before the round is Locked (captain, BriefComplete)", async () => {
    mockIdentity = { userId: "u", email: "c@x", roles: ["Pilot"], pilotId: "cap", clubId: "cA" };
    mockLoad(makeRound("BriefComplete"));

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /accounted for/i })).not.toBeInTheDocument(),
    );
  });
});

describe("RoundDetail — PureTrack rendering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    mockIdentity = null;
  });

  it("renders group link when ready and group exists", async () => {
    mockIdentity = { userId: "u", email: "m@x", roles: ["Pilot"], pilotId: "mem", clubId: "cA" };
    const r = makeRound("Locked");
    r.pureTrack = { status: "ready", attemptId: "1" };
    r.pureTrackGroupId = 123;
    r.pureTrackGroupName = "Group 1";
    r.pureTrackGroupSlug = "group-1";
    mockLoad(r);

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    const link = screen.getByRole("link", { name: "Group 1" });
    expect(link).toHaveAttribute("href", "https://puretrack.io/g/group-1");
  });

  it("renders 'No groups (none created)' when ready but no group exists", async () => {
    mockIdentity = { userId: "u", email: "m@x", roles: ["Pilot"], pilotId: "mem", clubId: "cA" };
    const r = makeRound("Locked");
    r.pureTrack = { status: "ready", attemptId: "1" };
    mockLoad(r);

    renderPage();

    await screen.findByRole("heading", { name: "Milk Hill" });
    expect(screen.getByText("No groups (none created)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /group/i })).not.toBeInTheDocument();
  });
});

describe("RoundDetail — rescore success modal survives the post-mutation reload", () => {

  const COUNTS: RescoreJobCounts = {
    rescoredCount: 3,
    skippedManualCount: 1,
    skippedNoIgcCount: 2,
    skippedBudgetCount: 0,
    errorCount: 0,
  };

  function job(status: RescoreJobStatus, counts?: RescoreJobCounts): RescoreJob {
    return {
      jobId: "job-1",
      roundId: "r1",
      status,
      requestedByEmail: "a@x",
      requestedAt: "2026-06-09T10:00:00Z",
      ...(counts ? { counts } : {}),
    };
  }

  async function flushMicrotasks() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockIdentity = null;
  });

  it("keeps the rescore success modal mounted after a completed poll (no full-page reload)", async () => {
    vi.useFakeTimers();
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };

    const round = makeRound("Locked");
    let roundFetchCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") {
        roundFetchCount += 1;
        // 1st call = initial load. The post-mutation reload (2nd call) stays
        // PENDING, modelling a real slow-network reload: on the buggy foreground
        // path `loading` latches true and unmounts the round subtree.
        return (roundFetchCount === 1
          ? Promise.resolve(round)
          : new Promise<never>(() => {})) as Promise<unknown>;
      }
      if (path === "rounds/r1/brief") {
        return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
      }
      if (path === "rounds/r1/rescore/job-1") {
        return Promise.resolve(job("completed", COUNTS)) as Promise<unknown>;
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    vi.mocked(api.post).mockResolvedValue({ jobId: "job-1", status: "queued" });

    renderPage();
    await flushMicrotasks();
    expect(screen.getByRole("heading", { name: "Milk Hill" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rescore-round-btn"));
    fireEvent.click(screen.getByTestId("rescore-confirm-yes"));
    await flushMicrotasks();

    // Completed poll: the button shows its success phase AND calls onChanged. A
    // foreground reload latches loading=true (reload pending), unmounting this
    // subtree and destroying the modal — the exact regression under lock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByTestId("rescore-success-modal")).toBeInTheDocument();
    expect(screen.getByTestId("rescore-count-rescored")).toHaveTextContent("3");
    expect(screen.queryByText(/Loading round/i)).toBeNull();
    const roundFetches = vi.mocked(api.get).mock.calls.filter(([p]) => p === "rounds/r1");
    expect(roundFetches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("RoundDetail — PureTrack rendering and polling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockIdentity = null;
  });

  it("renders pending/processing loaders and fails, then success link", async () => {
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };
    const baseRound = makeRound("Locked");
    baseRound.pureTrackGroupName = "Round 1 puretrack";
    baseRound.pureTrackGroupSlug = "round-1-puretrack";

    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") return Promise.resolve(baseRound) as Promise<unknown>;
      if (path === "rounds/r1/brief") return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    // 1. Pending
    baseRound.pureTrack = { status: "pending" };
    const { unmount } = renderPage();
    await screen.findByText("Queued…");

    // 2. Processing
    baseRound.pureTrack = { status: "processing" };
    unmount();
    renderPage();
    await screen.findByText("Creating…");

    // 3. Failed
    baseRound.pureTrack = { status: "failed" };
    unmount();
    renderPage();
    await screen.findByText("Creation failed");

    // 4. Ready with link
    baseRound.pureTrack = { status: "ready" };
    unmount();
    renderPage();
    const link = await screen.findByRole("link", { name: "Round 1 puretrack" });
    expect(link).toHaveAttribute("href", "https://puretrack.io/g/round-1-puretrack");
  });

  it("polls silently while PureTrack is pending/processing", async () => {
    vi.useFakeTimers();
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };
    const baseRound = makeRound("Locked");
    baseRound.pureTrackGroupName = "Round 1 puretrack";
    baseRound.pureTrackGroupSlug = "round-1-puretrack";
    baseRound.pureTrack = { status: "pending" };

    let roundFetchCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") {
        roundFetchCount += 1;
        // After 2 polls, return processing, then ready
        if (roundFetchCount === 3) baseRound.pureTrack = { status: "processing" };
        if (roundFetchCount === 5) baseRound.pureTrack = { status: "ready" };
        // Return a NEW object so React definitely re-renders!
        return Promise.resolve({ ...baseRound, pureTrack: { ...baseRound.pureTrack } }) as Promise<unknown>;
      }
      if (path === "rounds/r1/brief") return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderPage();

    // Let the initial fetch resolve
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Initial fetch
    expect(screen.getByText("Queued…")).toBeInTheDocument();
    expect(roundFetchCount).toBe(1);

    // Advance 3s -> poll 1
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(roundFetchCount).toBe(2);

    // Advance 4.5s -> poll 2 (now processing)
    await act(async () => { await vi.advanceTimersByTimeAsync(4600); });
    expect(roundFetchCount).toBe(3);
    expect(screen.getByText("Creating…")).toBeInTheDocument();

    // The component isn't unmounted and it should not show a full page spinner (silent = true)
    expect(screen.queryByText(/Loading round/i)).toBeNull();

    // Continue until ready
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(screen.getByText("Round 1 puretrack")).toBeInTheDocument();
  });

  it("polls successfully to ready even if the brief endpoint returns 500 on subsequent requests", async () => {
    vi.useFakeTimers();
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };
    const baseRound = makeRound("Locked");
    baseRound.pureTrackGroupName = "Round 1 puretrack";
    baseRound.pureTrackGroupSlug = "round-1-puretrack";
    baseRound.pureTrack = { status: "pending" };

    let roundFetchCount = 0;
    let briefFetchCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") {
        roundFetchCount += 1;
        if (roundFetchCount === 2) baseRound.pureTrack = { status: "ready" };
        return Promise.resolve({ ...baseRound, pureTrack: { ...baseRound.pureTrack } }) as Promise<unknown>;
      }
      if (path === "rounds/r1/brief") {
        briefFetchCount += 1;
        if (briefFetchCount === 1) return Promise.resolve({ version: 1 });
        return Promise.reject(new ApiError(500, "SERVER_ERROR", "broken brief"));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Queued…")).toBeInTheDocument();
    expect(roundFetchCount).toBe(1);
    expect(briefFetchCount).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });

    expect(roundFetchCount).toBe(2);
    expect(screen.getByText("Round 1 puretrack")).toBeInTheDocument();
  });

  it("surfaces retry affordance when poll timeout is reached", async () => {
    vi.useFakeTimers();
    mockIdentity = { userId: "u", email: "a@x", roles: ["Admin"], pilotId: null, clubId: null };
    const baseRound = makeRound("Locked");
    baseRound.pureTrackGroupName = "Round 1 puretrack";
    baseRound.pureTrackGroupSlug = "round-1-puretrack";
    baseRound.pureTrack = { status: "pending" };

    let roundFetchCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === "rounds/r1") {
        roundFetchCount += 1;
        return Promise.resolve({ ...baseRound, pureTrack: { ...baseRound.pureTrack } }) as Promise<unknown>;
      }
      if (path === "rounds/r1/brief") return Promise.reject(new ApiError(404, "NOT_FOUND", "no brief"));
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Queued…")).toBeInTheDocument();

    // Fast-forward through 15 polls
    for (let i = 0; i < 16; i++) {
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });
    }

    expect(screen.getByText("Still queued…")).toBeInTheDocument();
    const refreshBtn = screen.getByRole("button", { name: "Refresh" });

    // Clicking refresh should resume polling
    const fetchCountBefore = roundFetchCount;
    await act(async () => {
      fireEvent.click(refreshBtn);
      await Promise.resolve();
    });

    expect(roundFetchCount).toBe(fetchCountBefore + 1);
    expect(screen.getByText("Queued…")).toBeInTheDocument();

    vi.useRealTimers();
  });
});
