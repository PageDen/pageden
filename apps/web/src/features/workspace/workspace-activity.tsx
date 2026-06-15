import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { ApiError, api } from "../../lib/api";
import { workspaceActivityQuery } from "../../lib/queries";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { Button } from "../../components/ui/button";
import { ActivityRow } from "./activity-row";

export function WorkspaceActivity() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const initial = useQuery({ ...workspaceActivityQuery(workspaceId), enabled: workspaceId !== "" });
  const [extra, setExtra] = useState<Array<Awaited<ReturnType<typeof api.workspaceActivity>>["events"][number]>>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  usePageTitle(pageTitle("Activity"));

  if (initial.isLoading) return <div className="p-8 text-slate-400">Loading activity…</div>;
  if (initial.isError) {
    const notFound = initial.error instanceof ApiError && initial.error.status === 404;
    return <div className="p-8 text-slate-500">{notFound ? "Workspace not found." : "Could not load activity."}</div>;
  }
  const feed = initial.data!;
  const events = [...feed.events, ...extra];
  const cursor = nextBefore ?? feed.nextBefore;

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await api.workspaceActivity(workspaceId, cursor);
      setExtra((prev) => [...prev, ...next.events]);
      setNextBefore(next.nextBefore);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-8 text-slate-950 dark:text-slate-100">
      <header className="flex items-center gap-2">
        <Activity className="h-6 w-6 text-orange-600 dark:text-orange-300" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      </header>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Every document create, update, push (Obsidian), restore, and agent edit in this workspace.
      </p>

      <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {events.length === 0 ? (
          <p className="p-3 text-sm italic text-slate-400">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} workspaceId={workspaceId} />
            ))}
          </ul>
        )}
        {cursor ? (
          <div className="border-t border-slate-200 p-3 text-center dark:border-slate-800">
            <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
