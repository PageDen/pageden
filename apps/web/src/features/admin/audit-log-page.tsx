import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, crudErrorMessage, type AuditFilters } from "../../lib/api";
import { meQuery } from "../../lib/queries";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

type AuditEvent = Awaited<ReturnType<typeof api.auditEvents>>["events"][number];

export function AuditLogPage() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const me = useQuery(meQuery);
  const isAdmin = me.data?.workspaces.find((w) => w.id === workspaceId)?.role === "admin";

  const [actionInput, setActionInput] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = useMemo<AuditFilters>(
    () => ({
      action: actionInput.split(",").map((s) => s.trim()).filter(Boolean),
      actorUserId: actorUserId.trim() || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [actionInput, actorUserId, from, to],
  );

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.auditEvents(workspaceId, { ...filters, before: cursor, limit: 50 });
        setEvents((prev) => (cursor ? [...prev, ...res.events] : res.events));
        setNext(res.next);
      } catch (e) {
        setError(crudErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, filters],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function onExport(format: "csv" | "json") {
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const { blob, truncated, filename } = await api.downloadAuditExport(workspaceId, format, filters);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      if (truncated) setNotice("Export truncated to 10,000 most-recent rows — narrow the filters for the full set.");
    } catch (e) {
      setError(crudErrorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  const hasFilters = Boolean(filters.action?.length || filters.actorUserId || filters.from || filters.to);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Audit log</h2>
        <p className="text-sm text-slate-500">Every recorded action in this workspace. Filter, page, and export.</p>
      </div>

      {isAdmin ? <RetentionSection workspaceId={workspaceId} /> : null}
      {isAdmin ? <IntegritySection workspaceId={workspaceId} /> : null}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Action(s), comma-separated</span>
          <Input value={actionInput} onChange={(e) => setActionInput(e.target.value)} placeholder="permission_added, token_created" className="h-9 w-72" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Actor user ID</span>
          <Input value={actorUserId} onChange={(e) => setActorUserId(e.target.value)} placeholder="optional" className="h-9 w-48" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">From</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">To</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={() => onExport("csv")} disabled={exporting || (events.length === 0 && !hasFilters)}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button variant="ghost" onClick={() => onExport("json")} disabled={exporting || (events.length === 0 && !hasFilters)}>
            Export JSON
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-amber-700">{notice}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-700">{e.actor ? e.actor.email : <span className="text-slate-400">system</span>}</td>
                <td className="px-3 py-2 font-medium text-slate-900">{e.action}</td>
                <td className="px-3 py-2 text-slate-600">{e.targetType}{e.targetId ? `: ${e.targetId}` : ""}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-400">{e.ipAddress ?? "—"}</td>
              </tr>
            ))}
            {events.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-sm text-slate-400">
                  {hasFilters ? "No events match these filters." : "No audit events yet."}
                </td>
              </tr>
            ) : null}
            {loading && events.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-sm text-slate-400">Loading…</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {next ? (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void load(next)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type RetentionMode = "default" | "custom" | "forever";

function RetentionSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const retention = useQuery({
    queryKey: ["audit-retention", workspaceId],
    queryFn: () => api.auditRetention(workspaceId),
    retry: false,
  });
  const [mode, setMode] = useState<RetentionMode | null>(null);
  const [days, setDays] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive initial control state from the server value once loaded.
  const serverValue = retention.data?.auditRetentionDays;
  const effectiveMode: RetentionMode = mode ?? (serverValue == null ? "default" : serverValue === 0 ? "forever" : "custom");
  const effectiveDays = days !== "" ? days : serverValue && serverValue > 0 ? String(serverValue) : "";

  const save = useMutation({
    mutationFn: () => {
      const value = effectiveMode === "default" ? null : effectiveMode === "forever" ? 0 : Math.floor(Number(effectiveDays));
      return api.setAuditRetention(workspaceId, value);
    },
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["audit-retention", workspaceId] });
      window.setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  const invalidCustom = effectiveMode === "custom" && (!Number.isInteger(Number(effectiveDays)) || Number(effectiveDays) < 1 || Number(effectiveDays) > 3650);

  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="text-sm font-semibold text-slate-900">Retention</h3>
      <p className="mb-3 text-sm text-slate-500">How long to keep audit events. Older events are pruned daily.</p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Retention mode"
          className="h-9 rounded-md border border-slate-300 px-2 text-sm"
          value={effectiveMode}
          onChange={(e) => setMode(e.target.value as RetentionMode)}
        >
          <option value="default">Use default (365 days)</option>
          <option value="custom">Custom…</option>
          <option value="forever">Keep forever</option>
        </select>
        {effectiveMode === "custom" ? (
          <Input
            type="number"
            aria-label="Retention days"
            min={1}
            max={3650}
            value={effectiveDays}
            onChange={(e) => setDays(e.target.value)}
            placeholder="days"
            className="h-9 w-28"
          />
        ) : null}
        <Button onClick={() => save.mutate()} disabled={save.isPending || invalidCustom || retention.isLoading}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {saved ? <span className="text-sm text-green-700">Saved.</span> : null}
        {error ? <span className="text-sm text-red-600">{error}</span> : null}
      </div>
    </section>
  );
}

function IntegritySection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const integrity = useQuery({
    queryKey: ["audit-integrity", workspaceId],
    queryFn: () => api.auditIntegrity(workspaceId),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);

  const verify = useMutation({
    // Seal any pending events, then re-verify the whole chain.
    mutationFn: async () => {
      await api.createAuditCheckpoint(workspaceId);
      return api.auditIntegrity(workspaceId);
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["audit-integrity", workspaceId] });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  const data = integrity.data;
  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="text-sm font-semibold text-slate-900">Tamper-evidence</h3>
      <p className="mb-3 text-sm text-slate-500">
        Audit events are sealed hourly into a signed hash chain. Verify recomputes the chain from stored records and flags any change.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => verify.mutate()} disabled={verify.isPending || integrity.isLoading}>
          {verify.isPending ? "Verifying…" : "Verify now"}
        </Button>
        {data ? (
          data.ok ? (
            <span className="text-sm text-green-700">
              ✓ Chain intact — {data.verified} checkpoint{data.verified === 1 ? "" : "s"} verified
              {data.pruned > 0 ? `, ${data.pruned} aged out` : ""}
              {data.pendingCount > 0 ? `, ${data.pendingCount} pending` : ""}.
            </span>
          ) : (
            <span className="text-sm font-medium text-red-700">⚠ Tampering detected at checkpoint {data.brokenCheckpointId}.</span>
          )
        ) : null}
        {error ? <span className="text-sm text-red-600">{error}</span> : null}
      </div>
      {data?.lastSealedAt ? (
        <p className="mt-2 text-xs text-slate-400">Last sealed {new Date(data.lastSealedAt).toLocaleString()}.</p>
      ) : null}
    </section>
  );
}
