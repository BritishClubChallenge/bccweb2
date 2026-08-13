// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { describe, expect, it, vi } from "vitest";
import ResetPassword from "../ResetPassword.js";
import { api } from "../../../lib/api.js";

vi.mock("../../../lib/api.js", () => ({
  api: {
    post: vi.fn().mockResolvedValue(undefined)
  }
}));

describe("ResetPassword POST payload contract", () => {
  it("posts newPassword (not password) when the reset form is submitted", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/reset-password?token=reset-token"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
        </Routes>
      </MemoryRouter>
    );

    const [passwordInput, confirmInput] = container.querySelectorAll<HTMLInputElement>(
      'input[type="password"]'
    );
    if (!passwordInput || !confirmInput) {
      throw new Error("Expected both password inputs to be present");
    }
    const submitBtn = screen.getByRole("button", { name: "Set new password" });

    fireEvent.change(passwordInput, { target: { value: "ValidPassword123!" } });
    fireEvent.change(confirmInput, { target: { value: "ValidPassword123!" } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    expect(api.post).toHaveBeenCalledWith("auth/reset-password", {
      token: "reset-token",
      newPassword: "ValidPassword123!"
    });
  });
});
