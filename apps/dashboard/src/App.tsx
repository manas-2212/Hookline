import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ApiError, api, type Me, setCurrentApp } from "./api";
import { useLive } from "./live";
import { EndpointPage } from "./pages/Endpoint";
import { EndpointsPage } from "./pages/Endpoints";
import { KeysPage } from "./pages/Keys";
import { LoginPage, NewAppPage } from "./pages/Login";
import { MessagePage } from "./pages/Message";
import { MessagesPage } from "./pages/Messages";
import { OverviewPage } from "./pages/Overview";

interface Ctx {
  me: Me;
  app: Me["apps"][number];
  live: ReturnType<typeof useLive>;
  canWrite: boolean;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
};

const STORAGE_KEY = "hookline.app";
const readStored = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("GET", "/v1/me"),
    retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2,
  });
  if (me.isLoading) return <div className="center muted">Loading…</div>;
  if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
  if (me.error || !me.data) return <div className="center">Could not reach the Hookline API. Check that it is running.</div>;
  if (me.data.apps.length === 0) return <NewAppPage first />;
  return <Shell me={me.data} />;
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [appId, setAppId] = useState(() => {
    const stored = readStored();
    return me.apps.find((a) => a.id === stored)?.id ?? me.apps[0]?.id ?? "";
  });
  setCurrentApp(appId);
  const app = me.apps.find((a) => a.id === appId) ?? me.apps[0];

  // Refresh lists when the stream says something changed (debounced to one refetch per second).
  const [dirty, setDirty] = useState(0);
  const live = useLive(appId, () => setDirty((n) => n + 1));
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    }, 1000);
    return () => clearTimeout(t);
  }, [dirty, qc]);

  if (!app) return null;
  const switchApp = (id: string) => {
    if (id === "__new") return navigate("/apps/new");
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private mode */
    }
    setAppId(id);
    setCurrentApp(id);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    navigate("/");
  };
  const logout = async () => {
    await api("POST", "/v1/auth/logout");
    qc.clear();
    window.location.href = "/";
  };

  return (
    <AppCtx.Provider value={{ me, app, live, canWrite: app.role === "owner" }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="6" fill="var(--ink)" />
              <path d="M4 20h7l3-9 4 13 3-7h7" stroke="var(--paper)" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
            </svg>
            Hookline
          </div>
          <label>
            App
            <select value={app.id} onChange={(e) => switchApp(e.target.value)}>
              {me.apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              <option value="__new">New app…</option>
            </select>
          </label>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Overview
            </NavLink>
            <NavLink to="/endpoints">Endpoints</NavLink>
            <NavLink to="/messages">Messages</NavLink>
            {app.role === "owner" && <NavLink to="/keys">API keys</NavLink>}
          </nav>
          <div className="who">
            <span>
              Signed in as <strong>{me.user.login}</strong>
              {app.role === "viewer" && " (view only)"}
            </span>
            <button type="button" className="btn" onClick={logout}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/endpoints" element={<EndpointsPage />} />
            <Route path="/endpoints/:id" element={<EndpointPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/messages/:id" element={<MessagePage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/apps/new" element={<NewAppPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AppCtx.Provider>
  );
}
