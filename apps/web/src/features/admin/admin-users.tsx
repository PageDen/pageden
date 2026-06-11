import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, crudErrorMessage } from "../../lib/api";
import { usersQuery } from "../../lib/queries";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";

export function AdminUsers() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const queryClient = useQueryClient();
  const users = useQuery(usersQuery(workspaceId));
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "member" as "member" | "admin" });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createUser({ workspaceId, ...form }),
    onSuccess: () => {
      setForm({ email: "", name: "", password: "", role: "member" });
      setError(null);
      void queryClient.invalidateQueries({ queryKey: usersQuery(workspaceId).queryKey });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold">Users</h1>
      <form
        className="mb-5 grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <PasswordInput placeholder="Temp password (≥8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <select aria-label="Role" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" | "admin" })}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <div className="col-span-2 flex items-center justify-between">
          {error ? <span className="text-sm text-red-600">{error}</span> : <span />}
          <Button type="submit" disabled={create.isPending}>{create.isPending ? "Adding…" : "Add user"}</Button>
        </div>
      </form>

      {users.isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : users.isError ? (
        <p className="text-slate-500">{crudErrorMessage(users.error)}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {users.data!.users.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <div>
                <div className="font-medium">{u.name}</div>
                <div className="text-xs text-slate-400">{u.email}</div>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{u.role}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
