// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../lib/api.js";

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #ccc",
  borderRadius: "0.3rem",
  fontSize: "0.9rem",
  width: "100%",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "0.45rem 1.25rem",
  background: "#0066cc",
  color: "#fff",
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.9rem",
  width: "100%",
};

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <p style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>
          Invalid or missing reset token.
        </p>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <Link to="/forgot-password" style={{ color: "#0066cc" }}>Request a new reset link</Link>
        </p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("auth/reset-password", { token, newPassword: password });
      setDone(true);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Reset failed. The link may have expired.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Password updated</h1>
        <p style={{ color: "#0a3622", background: "#d1e7dd", padding: "0.75rem", borderRadius: "0.3rem", fontSize: "0.9rem" }}>
          Your password has been changed. You can now sign in with your new password.
        </p>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          <Link to="/login" style={{ color: "#0066cc" }}>Sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Set new password</h1>

      <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            New password <span style={{ color: "#888", fontWeight: 400 }}>(min. 8 characters)</span>
          </label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            style={inputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem", color: "#555" }}>
            Confirm new password
          </label>
          <input
            type="password"
            required
            autoComplete="new-password"
            style={inputStyle}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error && (
          <div style={{ padding: "0.5rem 0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem", fontSize: "0.85rem" }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} style={{ ...btnStyle, background: busy ? "#6c757d" : "#0066cc" }}>
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}
