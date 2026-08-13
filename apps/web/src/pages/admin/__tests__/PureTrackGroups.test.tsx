// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminPureTrackGroups from "../PureTrackGroups.js";
import { api, ApiError } from "../../../lib/api.js";
import * as useAuthModule from "../../../hooks/useAuth.js";

vi.mock("../../../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api.js")>("../../../lib/api.js");
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

vi.mock("../../../hooks/useAuth.js", () => ({
  useAuth: vi.fn(),
}));

import type { UserRole } from "@bccweb/types";

function mockAuth(roles: UserRole[] = ["Admin"]) {
  vi.mocked(useAuthModule.useAuth).mockReturnValue({
    identity: {
      userId: "admin-user",
      email: "admin@example.test",
      roles,
      pilotId: null,
      clubId: null,
    },
    loading: false,
    isRefreshing: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshIdentity: vi.fn(),
  });
}

describe("AdminPureTrackGroups", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("renders live groups", async () => {
    vi.mocked(api.get).mockResolvedValue([
      { id: 123, name: "Test Group", slug: "test-group" },
      { id: 456, name: "Other Group", slug: "other-group" }
    ]);

    render(<AdminPureTrackGroups />);

    expect(await screen.findByText("Test Group")).toBeVisible();
    expect(screen.getByText("test-group")).toBeVisible();
    expect(screen.getByText("Other Group")).toBeVisible();
    expect(screen.getByText("other-group")).toBeVisible();

    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "https://puretrack.io/g/test-group");
    expect(links[1]).toHaveAttribute("href", "https://puretrack.io/g/other-group");
  });

  it("selecting and deleting calls api.post with the ids", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([
      { id: 123, name: "Test Group", slug: "test-group" }
    ]);

    render(<AdminPureTrackGroups />);

    expect(await screen.findByText("Test Group")).toBeVisible();

    const checkbox = screen.getByRole("checkbox", { name: "Select group Test Group" });
    fireEvent.click(checkbox);

    vi.mocked(api.post).mockResolvedValueOnce({ deleted: 1, alreadyGone: 0 });

    // The second get after delete
    vi.mocked(api.get).mockResolvedValueOnce([]);

    const delBtn = screen.getByRole("button", { name: "Delete selected" });
    fireEvent.click(delBtn);

    expect(window.confirm).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith("manage/puretrack/groups/delete", { ids: [123] });

    await waitFor(() => {
      expect(screen.getByText(/Deleted: 1. Already gone: 0/)).toBeVisible();
    });
  });

  it("prevents selecting more than MAX_DELETE_BATCH groups", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([
      { id: 1, name: "G1", slug: "g1" },
      { id: 2, name: "G2", slug: "g2" },
      { id: 3, name: "G3", slug: "g3" },
      { id: 4, name: "G4", slug: "g4" },
      { id: 5, name: "G5", slug: "g5" },
      { id: 6, name: "G6", slug: "g6" },
    ]);

    render(<AdminPureTrackGroups />);
    expect(await screen.findByText("G1")).toBeVisible();

    for (let i = 1; i <= 5; i++) {
      fireEvent.click(screen.getByTestId(`select-${i}`));
    }

    expect(screen.getByTestId("select-6")).toBeDisabled();

    expect(screen.getByText("Limit reached: 5 groups")).toBeVisible();

    fireEvent.click(screen.getByTestId("select-5"));
    expect(screen.getByTestId("select-6")).not.toBeDisabled();
    expect(screen.queryByText("Limit reached: 5 groups")).not.toBeInTheDocument();
  });

  it("non-Admin shows the guard", () => {
    mockAuth(["Pilot"]);
    render(<AdminPureTrackGroups />);
    expect(screen.getByText("Admin access required.")).toBeVisible();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("api.get ApiError rejection shows detail instead of generic message", async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(409, "Conflict", "Lock contention on Round 123"));
    render(<AdminPureTrackGroups />);
    expect(await screen.findByText("Lock contention on Round 123")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("api.post ApiError rejection on delete shows detail", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([
      { id: 123, name: "Test Group", slug: "test-group" }
    ]);
    render(<AdminPureTrackGroups />);
    expect(await screen.findByText("Test Group")).toBeVisible();

    const checkbox = screen.getByTestId("select-123");
    fireEvent.click(checkbox);

    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, "Conflict", "Group is currently active"));
    const delBtn = screen.getByRole("button", { name: "Delete selected" });
    fireEvent.click(delBtn);

    await waitFor(() => {
      expect(screen.getByText("Group is currently active")).toBeVisible();
    });
  });
});
