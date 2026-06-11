import { Link, Outlet, useParams } from "@tanstack/react-router";

export function AdminLayout() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const tab = "rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 [&.active]:bg-slate-200 [&.active]:font-medium";
  return (
    <div className="p-8">
      <nav className="mb-6 flex gap-1 border-b border-slate-200 pb-2">
        <Link to="/w/$workspaceId/admin/users" params={{ workspaceId }} className={tab}>Users</Link>
        <Link to="/w/$workspaceId/admin/groups" params={{ workspaceId }} className={tab}>Groups</Link>
      </nav>
      <Outlet />
    </div>
  );
}
