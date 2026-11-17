import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApp } from "../App";
import { api } from "../api";
import { Time } from "../components/bits";

interface Key {
  id: string;
  prefix: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function KeysPage() {
  const { app } = useApp();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys", app.id], queryFn: () => api<{ items: Key[] }>("GET", "/v1/api-keys") });
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api<{ key: string }>("POST", "/v1/api-keys", { label: label.trim() || null });
    setFresh(r.key);
    setLabel("");
    qc.invalidateQueries({ queryKey: ["keys"] });
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this key? Anything using it will start getting 401 errors.")) return;
    await api("DELETE", `/v1/api-keys/${id}`);
    qc.invalidateQueries({ queryKey: ["keys"] });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API keys</h1>
          <p>Your services use these to publish messages to {app.name}. Hookline stores only a hash, so a key is shown once.</p>
        </div>
      </div>
      {fresh && (
        <div className="notice secret">
          <p>
            Copy this key now:
            <br />
            <code>{fresh}</code>
          </p>
        </div>
      )}
      <form className="row" onSubmit={create} style={{ marginBottom: 24 }}>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="billing-service production" />
        </label>
        <button className="btn primary" type="submit">
          Create key
        </button>
      </form>
      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Label</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(keys.data?.items ?? []).map((k) => (
            <tr key={k.id}>
              <td className="mono">{k.prefix}…</td>
              <td>{k.label ?? <span className="muted">no label</span>}</td>
              <td>
                <Time iso={k.created_at} />
              </td>
              <td className="num">
                {k.revoked_at ? (
                  <span className="muted">
                    revoked <Time iso={k.revoked_at} />
                  </span>
                ) : (
                  <button type="button" className="btn danger" onClick={() => revoke(k.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
