import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";

export function LoginPage() {
  const qc = useQueryClient();
  const opts = useQuery({ queryKey: ["auth-options"], queryFn: () => api<{ github: boolean; dev_login: boolean }>("GET", "/v1/auth/options") });
  const [login, setLogin] = useState("dev");
  const [err, setErr] = useState<string | null>(null);

  const devLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("POST", "/v1/auth/dev-login", { login });
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (x) {
      setErr(x instanceof ApiError ? x.detail : "Sign-in failed");
    }
  };

  return (
    <div className="center">
      <div className="login">
        <h1>Sign in to Hookline</h1>
        <p>See every webhook you send, where it went, and what the other side said back.</p>
        {opts.data?.github && (
          <a className="btn primary" href="/auth/github" style={{ textAlign: "center", textDecoration: "none" }}>
            Sign in with GitHub
          </a>
        )}
        {opts.data?.dev_login && (
          <form onSubmit={devLogin} className="form">
            <label>
              Development sign-in (no password; DEV_LOGIN is on)
              <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
            </label>
            <button className="btn" type="submit">
              Sign in as {login || "…"}
            </button>
          </form>
        )}
        {opts.data && !opts.data.github && !opts.data.dev_login && (
          <p className="notice err">No sign-in method is configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the API.</p>
        )}
        {err && <p className="notice err">{err}</p>}
      </div>
    </div>
  );
}

export function NewAppPage({ first = false }: { first?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const app = await api<{ id: string }>("POST", "/v1/apps", { name: name.trim() });
    try {
      localStorage.setItem("hookline.app", app.id);
    } catch {
      /* ignore */
    }
    await qc.invalidateQueries({ queryKey: ["me"] });
    navigate("/");
    window.location.reload();
  };
  const body = (
    <form className="form" onSubmit={create}>
      <h1>{first ? "Create your first app" : "New app"}</h1>
      <p className="muted">An app is one product that sends webhooks. It has its own endpoints, messages and API keys.</p>
      <label>
        App name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing service" />
      </label>
      <div>
        <button className="btn primary" type="submit" disabled={!name.trim()}>
          Create app
        </button>
      </div>
    </form>
  );
  return first ? <div className="center">{body}</div> : body;
}
