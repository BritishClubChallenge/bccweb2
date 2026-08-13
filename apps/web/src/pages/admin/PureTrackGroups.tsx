// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: "0.35rem 0.75rem",
  background: bg,
  color,
  border: "none",
  borderRadius: "0.3rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.8rem",
});

function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div style={{
      padding: "0.4rem 0.6rem",
      borderRadius: "0.3rem",
      fontSize: "0.8rem",
      marginBottom: "1rem",
      background: ok ? "#d1e7dd" : "#f8d7da",
      color: ok ? "#0a3622" : "#58151c",
    }}>
      {msg}
    </div>
  );
}

interface Group {
  id: number;
  name: string;
  slug: string;
}

const MAX_DELETE_BATCH = 5; // Must match DeletePureTrackGroupsBodySchema in API

export default function AdminPureTrackGroups() {
  const { identity, loading: authLoading } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const isAdmin = identity?.roles.includes("Admin");

  async function load() {
    setLoading(true);
    setLoadErr(null);
    try {
      const data = await api.get<Group[]>("manage/puretrack/groups/live");
      setGroups(data);
      setSelectedIds(new Set());
    } catch (ex) {
      setLoadErr(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to load groups");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin]);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected group(s)?`)) return;

    setBusy(true);
    setMsg(null);
    try {
      const result = await api.post<{ deleted: number; alreadyGone: number }>("manage/puretrack/groups/delete", {
        ids: Array.from(selectedIds),
      });
      setMsg(`Deleted: ${result.deleted}. Already gone: ${result.alreadyGone}.`);
      setMsgOk(true);
      await load();
    } catch (ex) {
      setMsg(ex instanceof ApiError ? (ex.detail ?? ex.message) : ex instanceof Error ? ex.message : "Failed to delete");
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }

  if (authLoading || (isAdmin && loading)) return <LoadingSpinner message="Loading groups…" />;
  if (!isAdmin) return <p style={{ color: "#721c24" }}>Admin access required.</p>;
  if (loadErr) return <div style={{ padding: "0.75rem", background: "#f8d7da", color: "#58151c", borderRadius: "0.3rem" }}>{loadErr}</div>;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>PureTrack Groups</h1>

      {msg && <Banner msg={msg} ok={msgOk} />}

      <div style={{ border: "1px solid #dee2e6", borderRadius: "0.5rem", padding: "1rem", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0" }}>Live Groups</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            {selectedIds.size >= MAX_DELETE_BATCH && (
              <span style={{ fontSize: "0.8rem", color: "#666" }}>
                Limit reached: {MAX_DELETE_BATCH} groups
              </span>
            )}
            <button
              onClick={handleDelete}
              disabled={busy || selectedIds.size === 0 || selectedIds.size > MAX_DELETE_BATCH}
              style={btnStyle("#fff", busy || selectedIds.size === 0 || selectedIds.size > MAX_DELETE_BATCH ? "#6c757d" : "#dc3545")}
            >
              {busy ? "Deleting…" : "Delete selected"}
            </button>
          </div>
        </div>

        {groups.length === 0 ? (
          <p style={{ fontSize: "0.9rem", color: "#666" }}>No live groups found.</p>
        ) : (
          <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                <th style={{ padding: "0.25rem", width: "40px" }}></th>
                <th style={{ padding: "0.25rem" }}>Name</th>
                <th style={{ padding: "0.25rem" }}>Slug</th>
                <th style={{ padding: "0.25rem" }}>Link</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.35rem 0.25rem" }}>
                    <input
                      type="checkbox"
                      aria-label={`Select group ${g.name}`}
                      checked={selectedIds.has(g.id)}
                      onChange={() => toggleSelect(g.id)}
                      disabled={!selectedIds.has(g.id) && selectedIds.size >= MAX_DELETE_BATCH}
                      data-testid={`select-${g.id}`}
                    />
                  </td>
                  <td style={{ padding: "0.35rem 0.25rem" }}>{g.name}</td>
                  <td style={{ padding: "0.35rem 0.25rem" }}>{g.slug}</td>
                  <td style={{ padding: "0.35rem 0.25rem" }}>
                    <a
                      href={`https://puretrack.io/g/${g.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#0066cc", textDecoration: "none" }}
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
