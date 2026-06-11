import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { formatDateTime } from "../../lib/format";

export function DevicesPage() {
  const [userCode, setUserCode] = useState("");
  const [details, setDetails] = useState<{ ipAddress: string | null; createdAt: string } | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: () => api.lookupDevice(userCode.trim()),
    onSuccess: (d) => { setError(null); setDetails(d); },
    onError: (e) => { setDetails(null); setError(crudErrorMessage(e)); },
  });
  const decide = useMutation({
    mutationFn: (action: "approve" | "deny") => api.approveDevice(userCode.trim(), action),
    onSuccess: (_r, action) => { setError(null); setDone(action === "approve" ? "approved" : "denied"); },
    onError: (e) => { setError(crudErrorMessage(e)); setDetails(null); },
  });

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="mb-1 text-xl font-semibold">Approve a device</h1>
      <p className="mb-4 text-sm text-slate-500">Enter the code shown by the Obsidian plugin to link it to your account.</p>

      {done === "approved" ? (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">Device approved — return to Obsidian to finish.</p>
      ) : done === "denied" ? (
        <p className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">Device denied.</p>
      ) : details ? (
        <div className="space-y-3">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            A device wants access to <strong>your account</strong>. Approve <strong>only</strong> if you just started a
            login from the Obsidian plugin.
            <div className="mt-2 text-xs text-amber-700">
              Requested {formatDateTime(details.createdAt)}{details.ipAddress ? ` from ${details.ipAddress}` : ""}.
            </div>
          </div>
          <div className="flex gap-2">
            <Button disabled={decide.isPending} onClick={() => decide.mutate("approve")}>{decide.isPending ? "Working…" : "Approve"}</Button>
            <Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate("deny")}>Deny</Button>
            <Button variant="ghost" onClick={() => setDetails(null)}>Cancel</Button>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); lookup.mutate(); }}>
          <Input aria-label="Device code" placeholder="XXXX-XXXX" value={userCode} onChange={(e) => setUserCode(e.target.value)} autoFocus required />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={lookup.isPending || !userCode.trim()}>{lookup.isPending ? "Checking…" : "Continue"}</Button>
        </form>
      )}
    </div>
  );
}
