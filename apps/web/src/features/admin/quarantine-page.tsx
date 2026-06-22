import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

type QuarantinedAttachment = Awaited<ReturnType<typeof api.quarantineList>>["attachments"][number];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function QuarantinePage() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const queryClient = useQueryClient();

  const [items, setItems] = useState<QuarantinedAttachment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.quarantineList(workspaceId, cursor);
        setItems((prev) => (cursor ? [...prev, ...res.attachments] : res.attachments));
        setNext(res.next);
      } catch (e) {
        setError(crudErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const release = useMutation({
    mutationFn: (attachmentId: string) => api.unquarantine(attachmentId),
    onSuccess: (_data, attachmentId) => {
      setItems((prev) => prev.filter((a) => a.id !== attachmentId));
      setNotice("Attachment released for re-scanning.");
      void queryClient.invalidateQueries({ queryKey: ["quarantine", workspaceId] });
      window.setTimeout(() => setNotice(null), 4000);
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Quarantine</h2>
        <p className="text-sm text-slate-500">Files blocked by the antivirus scanner. Release re-queues the file for a fresh scan.</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-green-700">{notice}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Filename</th>
              <th className="px-3 py-2 font-medium">Document</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Uploaded by</th>
              <th className="px-3 py-2 font-medium">Quarantined</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((a) => (
              <tr key={a.id} className="align-top">
                <td className="max-w-[180px] truncate px-3 py-2 font-medium text-slate-900" title={a.filename}>{a.filename}</td>
                <td className="max-w-[180px] truncate px-3 py-2 text-slate-600" title={a.documentTitle}>{a.documentTitle}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{a.contentType}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatBytes(a.size)}</td>
                <td className="max-w-[160px] truncate px-3 py-2 text-slate-500">{a.uploadedByEmail}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-400">{new Date(a.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={release.isPending}
                    onClick={() => release.mutate(a.id)}
                  >
                    Release
                  </Button>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-400">No quarantined files.</td>
              </tr>
            ) : null}
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-400">Loading…</td>
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
