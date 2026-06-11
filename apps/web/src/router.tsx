import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { currentWorkspaceQuery, meQuery } from "./lib/queries";
import { ApiError, setOnUnauthorized } from "./lib/api";
import { LoginPage } from "./features/auth/login-page";
import { lazy, Suspense } from "react";
import { WorkspaceShell, WorkspaceEmptyState, WorkspaceChooser } from "./features/workspace/workspace-shell";

// Code-split the Markdown-heavy read views out of the main bundle.
const DocumentView = lazy(() => import("./features/document/document-view").then((m) => ({ default: m.DocumentView })));
const RevisionHistory = lazy(() => import("./features/document/revision-history").then((m) => ({ default: m.RevisionHistory })));
const TokensPage = lazy(() => import("./features/admin/tokens-page").then((m) => ({ default: m.TokensPage })));
const AgentsPage = lazy(() => import("./features/admin/agents-page").then((m) => ({ default: m.AgentsPage })));
const AccountPage = lazy(() => import("./features/account/account-page").then((m) => ({ default: m.AccountPage })));
const ImportPage = lazy(() => import("./features/import/import-page").then((m) => ({ default: m.ImportPage })));
const OnboardingPage = lazy(() => import("./features/onboarding/onboarding-page").then((m) => ({ default: m.OnboardingPage })));
const ForgotPasswordPage = lazy(() => import("./features/auth/forgot-password-page").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("./features/auth/reset-password-page").then((m) => ({ default: m.ResetPasswordPage })));
const RegisterPage = lazy(() => import("./features/auth/register-page").then((m) => ({ default: m.RegisterPage })));
const VerifyEmailPage = lazy(() => import("./features/auth/verify-email-page").then((m) => ({ default: m.VerifyEmailPage })));
const CreateWorkspacePage = lazy(() => import("./features/workspace/create-workspace-page").then((m) => ({ default: m.CreateWorkspacePage })));
const AdminLayout = lazy(() => import("./features/admin/admin-layout").then((m) => ({ default: m.AdminLayout })));
const AdminUsers = lazy(() => import("./features/admin/admin-users").then((m) => ({ default: m.AdminUsers })));
const AdminGroups = lazy(() => import("./features/admin/admin-groups").then((m) => ({ default: m.AdminGroups })));
const DevicesPage = lazy(() => import("./features/admin/devices-page").then((m) => ({ default: m.DevicesPage })));

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="p-8 text-slate-400">Loading…</div>}>{children}</Suspense>;
}

interface RouterContext {
  queryClient: QueryClient;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: async ({ context }) => {
    let authed = false;
    try {
      await context.queryClient.ensureQueryData(meQuery);
      authed = true;
    } catch {
      // not authenticated — stay on /login
    }
    if (authed) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: () => (
    <Lazy>
      <ForgotPasswordPage />
    </Lazy>
  ),
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: () => (
    <Lazy>
      <ResetPasswordPage />
    </Lazy>
  ),
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: () => (
    <Lazy>
      <RegisterPage />
    </Lazy>
  ),
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  component: () => (
    <Lazy>
      <VerifyEmailPage />
    </Lazy>
  ),
});

// Pathless guard: requires an authenticated session; redirects to /login otherwise.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authed",
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    let currentWorkspaceId: string | null = null;
    let routeScoped = false;
    try {
      const current = await context.queryClient.ensureQueryData(currentWorkspaceQuery);
      currentWorkspaceId = current.workspace.id;
      routeScoped = current.routingMode === "cloud_subdomain" || current.routingMode === "custom_domain" || current.routingMode === "explicit";
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (routeScoped && currentWorkspaceId) throw redirect({ to: "/w/$workspaceId", params: { workspaceId: currentWorkspaceId } });
    if (me.workspaces.length === 1) throw redirect({ to: "/w/$workspaceId", params: { workspaceId: me.workspaces[0]!.id } });
    const first = me.workspaces[0];
    if (!first && currentWorkspaceId) throw redirect({ to: "/w/$workspaceId", params: { workspaceId: currentWorkspaceId } });
    if (!first) throw redirect({ to: "/onboarding" });
  },
  component: WorkspaceChooser,
});

const onboardingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/onboarding",
  component: () => (
    <Lazy>
      <OnboardingPage />
    </Lazy>
  ),
});

const workspaceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/w/$workspaceId",
  component: WorkspaceShell,
});

const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  component: WorkspaceEmptyState,
});

const documentRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "d/$documentId",
  component: () => (
    <Lazy>
      <DocumentView />
    </Lazy>
  ),
});

const documentHistoryRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "d/$documentId/history",
  component: () => (
    <Lazy>
      <RevisionHistory />
    </Lazy>
  ),
});

const tokensRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "tokens",
  component: () => (
    <Lazy>
      <TokensPage />
    </Lazy>
  ),
});

const agentsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "agents",
  component: () => (
    <Lazy>
      <AgentsPage />
    </Lazy>
  ),
});

const accountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "account",
  component: () => (
    <Lazy>
      <AccountPage />
    </Lazy>
  ),
});

const importRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "import",
  component: () => (
    <Lazy>
      <ImportPage />
    </Lazy>
  ),
});

const adminRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "admin",
  beforeLoad: async ({ context, params }) => {
    await context.queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    const me = await context.queryClient.ensureQueryData(meQuery);
    const ws = me.workspaces.find((w) => w.id === (params as { workspaceId: string }).workspaceId);
    if (ws?.role !== "admin") throw redirect({ to: "/w/$workspaceId", params: { workspaceId: (params as { workspaceId: string }).workspaceId } });
  },
  component: () => (
    <Lazy>
      <AdminLayout />
    </Lazy>
  ),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: () => (
    <Lazy>
      <AdminUsers />
    </Lazy>
  ),
});

const adminGroupsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "groups",
  component: () => (
    <Lazy>
      <AdminGroups />
    </Lazy>
  ),
});

const devicesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/devices",
  component: () => (
    <Lazy>
      <DevicesPage />
    </Lazy>
  ),
});

const createWorkspaceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/workspaces/new",
  component: () => (
    <Lazy>
      <CreateWorkspacePage />
    </Lazy>
  ),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  verifyEmailRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  authedRoute.addChildren([
    indexRoute,
    onboardingRoute,
    devicesRoute,
    createWorkspaceRoute,
    workspaceRoute.addChildren([
      workspaceIndexRoute,
      documentRoute,
      documentHistoryRoute,
      tokensRoute,
      agentsRoute,
      accountRoute,
      importRoute,
      adminRoute.addChildren([adminUsersRoute, adminGroupsRoute]),
    ]),
  ]),
]);

export const router = createRouter({ routeTree, context: { queryClient } });

// Bounce to /login on any 401 (e.g. session expiry after the app is mounted).
setOnUnauthorized(() => {
  queryClient.setQueryData(meQuery.queryKey, undefined);
  if (router.state.location.pathname !== "/login") void router.navigate({ to: "/login" });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
