import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * Branding shown atop the login/signup forms. When the page is served from a
 * workspace subdomain (cloud), it shows that company's name + logo; otherwise
 * the default Pageden mark. `publicCurrentWorkspace` resolves by Host, so it is
 * null off-subdomain and on self-hosted — no extra gating needed here.
 */
export function AuthBrandHeader() {
  const ws = useQuery({
    queryKey: ["workspaces", "current-public"],
    queryFn: () => api.publicCurrentWorkspace(),
    retry: false,
    staleTime: 60_000,
  });
  const workspace = ws.data?.workspace ?? null;
  const name = workspace?.name ?? "Pageden";
  const logoUrl = workspace?.logoUrl ?? null;
  const initial = name.trim().charAt(0).toUpperCase() || "P";

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2.5">
        {logoUrl ? (
          <img src={logoUrl} alt={name} className="h-8 w-8 rounded-lg bg-white object-contain shadow-sm" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-600 text-sm font-semibold text-white shadow-sm">
            {workspace ? initial : "P"}
          </span>
        )}
        <span className="text-sm font-semibold text-slate-900">{name}</span>
      </div>
      <p className="text-xs leading-snug text-slate-400">
        {workspace ? "Your team's source of truth." : "One source of truth for people and AI."}
      </p>
    </div>
  );
}
