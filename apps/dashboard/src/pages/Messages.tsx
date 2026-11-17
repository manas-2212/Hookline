import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApp } from "../App";
import { api, type MessageSummary } from "../api";
import { MessageRows } from "./Endpoint";

export function MessagesPage() {
  const { app } = useApp();
  const [params, setParams] = useSearchParams();
  const endpoint = params.get("endpoint") ?? "";
  const type = params.get("event_type") ?? "";
  const [draft, setDraft] = useState(type);

  const q = useInfiniteQuery({
    queryKey: ["messages", app.id, type, endpoint],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const s = new URLSearchParams({ limit: "50" });
      if (pageParam) s.set("cursor", pageParam);
      if (type) s.set("event_type", type);
      if (endpoint) s.set("endpoint_id", endpoint);
      return api<{ items: MessageSummary[]; next: string | null }>("GET", `/v1/messages?${s}`);
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p>Every event your app published, newest first, with where each one ended up.</p>
        </div>
      </div>
      <form
        className="row"
        style={{ marginBottom: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams(params);
          if (draft.trim()) next.set("event_type", draft.trim());
          else next.delete("event_type");
          setParams(next);
        }}
      >
        <label>
          Event type
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="invoice.paid" />
        </label>
        <button className="btn" type="submit">
          Filter
        </button>
        {(type || endpoint) && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              setDraft("");
              setParams({});
            }}
          >
            Clear filters
          </button>
        )}
      </form>
      {endpoint && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          Showing messages sent to one endpoint.
        </p>
      )}
      <MessageRows items={items} />
      {q.hasNextPage && (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? "Loading…" : "Load older messages"}
          </button>
        </div>
      )}
    </>
  );
}
