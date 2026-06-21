import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

export function AdminLayout() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const authConfig = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60 * 1000, retry: false });
  const tab = "rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 [&.active]:bg-slate-200 [&.active]:font-medium";
  return (
    <div className="p-8">
      <nav className="mb-6 flex gap-1 border-b border-slate-200 pb-2">
        <Link to="/w/$workspaceId/admin/users" params={{ workspaceId }} className={tab}>Users</Link>
        <Link to="/w/$workspaceId/admin/groups" params={{ workspaceId }} className={tab}>Groups</Link>
        <Link to="/w/$workspaceId/admin/settings" params={{ workspaceId }} className={tab}>Settings</Link>
        {authConfig.data?.cloudHosted ? (
          <Link to="/w/$workspaceId/admin/audit" params={{ workspaceId }} className={tab}>Audit log</Link>
        ) : null}
      </nav>
      <Outlet />
    </div>
  );
}
