import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { AlertTriangle, LockKeyhole, SearchX, type LucideIcon } from "lucide-react";
import { ApiError, api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { PasswordInput } from "../../components/ui/password-input";
import { previewSanitizeSchema, rehypeAllowlistIframes } from "../document/media-sanitize";
import { isAllowedEmbedSrc } from "../document/media";
import { headingId } from "../document/table-of-contents";

const sharePasswords = new Map<string, string>();

export function PublicShareReader() {
  const params = useParams({ strict: false }) as { slug?: string; docId?: string };
  const navigate = useNavigate();
  const slug = params.slug ?? "";
  const docId = params.docId;
  const [passwordDraft, setPasswordDraft] = useState("");
  const [password, setPassword] = useState<string | null>(() => sharePasswords.get(slug) ?? null);
  const [passwordAttempt, setPasswordAttempt] = useState(0);

  const manifest = useQuery({
    queryKey: ["public-share", slug, password, passwordAttempt],
    queryFn: () => api.publicShare(slug, password),
    enabled: Boolean(slug),
    retry: false,
  });
  const page = useQuery({
    queryKey: ["public-share-page", slug, docId, password, passwordAttempt],
    queryFn: () => api.publicSharePage(slug, docId!, password),
    enabled: Boolean(slug && docId),
    retry: false,
  });

  const passwordError = passwordState(manifest.error) ?? passwordState(page.error);
  if (passwordError) {
    return (
      <PublicState icon={LockKeyhole} title="Password required">
        <form
          className="mt-5 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const next = passwordDraft.trim();
            sharePasswords.set(slug, next);
            setPassword(next);
            setPasswordAttempt((value) => value + 1);
          }}
        >
          <PasswordInput
            aria-label="Share password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            autoFocus
          />
          {passwordError === "wrong" ? <p className="text-sm text-red-600">Incorrect password.</p> : null}
          <Button type="submit" className="w-full" disabled={!passwordDraft.trim()}>
            Open share
          </Button>
        </form>
      </PublicState>
    );
  }

  if (manifest.isLoading) {
    return <PublicState title="Loading…" />;
  }

  if (isNotFound(manifest.error) || isNotFound(page.error)) {
    return (
      <PublicState icon={SearchX} title="Share unavailable">
        <p className="mt-2 text-sm text-slate-500">This link may have expired, been revoked, or public sharing may be disabled.</p>
      </PublicState>
    );
  }

  if (manifest.isError) {
    return (
      <PublicState icon={AlertTriangle} title="Could not open share">
        <p className="mt-2 text-sm text-slate-500">{crudErrorMessage(manifest.error)}</p>
      </PublicState>
    );
  }

  const data = manifest.data;
  if (!data) return null;

  if (data.type === "document") {
    return (
      <PublicLayout title={data.title} subtitle={data.path}>
        <PublicMarkdown content={data.content} slug={slug} password={password} />
      </PublicLayout>
    );
  }

  const activeDocId = docId ?? data.landing?.docId ?? null;
  const activeTitle = page.data?.title ?? data.landing?.title ?? data.title;
  const content = docId ? page.data?.content : data.landing?.content;

  return (
    <div className="flex min-h-screen bg-white text-slate-900">
      <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-slate-50/80 lg:block">
        <div className="sticky top-0 flex max-h-screen flex-col">
          <div className="border-b border-slate-200 px-5 py-5">
            <h1 className="truncate text-base font-semibold text-slate-950" title={data.title}>{data.title}</h1>
            <p className="mt-1 text-xs text-slate-500">PageDen manual</p>
          </div>
          <nav className="min-h-0 flex-1 overflow-auto px-3 py-4 text-sm">
            {data.nav.map((item) => (
              <Link
                key={item.docId}
                to="/s/$slug/p/$docId"
                params={{ slug, docId: item.docId }}
                className={`block truncate rounded-md px-2 py-1.5 text-slate-600 transition hover:bg-white hover:text-slate-950 ${
                  activeDocId === item.docId ? "bg-white font-medium text-orange-700 shadow-sm" : ""
                }`}
                style={{ paddingLeft: `${8 + Math.min(item.depth, 6) * 12}px` }}
                title={item.title}
              >
                {item.title}
              </Link>
            ))}
          </nav>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-[920px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
          <header className="mb-6 border-b border-slate-200 pb-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">PageDen manual</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">{activeTitle}</h1>
            {data.nav.length > 0 ? (
              <select
                aria-label="Manual page"
                className="mt-4 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 shadow-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 lg:hidden"
                value={activeDocId ?? ""}
                onChange={(event) => {
                  const nextDocId = event.target.value;
                  if (nextDocId) void navigate({ to: "/s/$slug/p/$docId", params: { slug, docId: nextDocId } });
                }}
              >
                {data.nav.map((item) => (
                  <option key={item.docId} value={item.docId}>
                    {`${item.depth > 0 ? "  ".repeat(Math.min(item.depth, 6)) : ""}${item.title}`}
                  </option>
                ))}
              </select>
            ) : null}
          </header>
          {page.isLoading && docId ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : page.isError ? (
            <p className="text-sm text-red-600">{crudErrorMessage(page.error)}</p>
          ) : content ? (
            <PublicMarkdown content={content} slug={slug} password={password} />
          ) : (
            <p className="text-sm text-slate-500">No public documents.</p>
          )}
        </div>
      </main>
    </div>
  );
}

function PublicLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-[920px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        <header className="mb-6 border-b border-slate-200 pb-5">
          <h1 className="text-3xl font-semibold tracking-normal text-slate-950">{title}</h1>
          {subtitle ? <p className="mt-2 break-words text-sm text-slate-500">{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}

function PublicMarkdown({ content, slug, password }: { content: string; slug: string; password: string | null }) {
  const rewritePublicUrl = useMemo(() => attachmentUrlRewriter(slug, password), [password, slug]);
  return (
    <article className="pageden-document-view prose prose-slate max-w-none break-words text-[16px] leading-8 sm:text-[15px] sm:leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSanitizeSchema], rehypeAllowlistIframes]}
        components={{
          a: ({ href, children, className, ...props }) => {
            const linkClassName = [
              "font-medium text-orange-700 underline decoration-orange-300 underline-offset-4 transition hover:text-orange-800 hover:decoration-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300",
              className,
            ].filter(Boolean).join(" ");
            return <a {...props} href={rewritePublicUrl(href)} className={linkClassName}>{children}</a>;
          },
          img: ({ src, alt, ...props }) => (
            <img {...props} src={rewritePublicUrl(src)} alt={alt ?? ""} className="max-w-full rounded" />
          ),
          video: ({ src, ...props }) => (
            <video {...props} src={rewritePublicUrl(src)} controls className="max-w-full rounded" />
          ),
          table: ({ children, ...props }) => (
            <div className="pageden-table-scroll">
              <table {...props}>{children}</table>
            </div>
          ),
          h1: ({ children, ...props }) => <h1 {...props} id={headingId(markdownText(children))}>{children}</h1>,
          h2: ({ children, ...props }) => <h2 {...props} id={headingId(markdownText(children))}>{children}</h2>,
          h3: ({ children, ...props }) => <h3 {...props} id={headingId(markdownText(children))}>{children}</h3>,
          h4: ({ children, ...props }) => <h4 {...props} id={headingId(markdownText(children))}>{children}</h4>,
          h5: ({ children, ...props }) => <h5 {...props} id={headingId(markdownText(children))}>{children}</h5>,
          h6: ({ children, ...props }) => <h6 {...props} id={headingId(markdownText(children))}>{children}</h6>,
          iframe: ({ src, ...props }) =>
            src && isAllowedEmbedSrc(src) ? (
              <span className="block aspect-video w-full max-w-2xl overflow-hidden rounded">
                <iframe {...props} src={src} className="h-full w-full" allowFullScreen title="Embedded media" />
              </span>
            ) : null,
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

function PublicState({
  icon: Icon,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        {Icon ? <Icon className="mx-auto mb-3 h-8 w-8 text-slate-400" aria-hidden="true" /> : null}
        <h1 className="text-lg font-semibold text-slate-950">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function passwordState(error: unknown): "missing" | "wrong" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401 || error.code === "password_required") return "missing";
  if (error.status === 403 || error.code === "wrong_password") return "wrong";
  return null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function attachmentUrlRewriter(slug: string, password: string | null) {
  return (value: string | undefined) => {
    if (!value || !password || !value.startsWith(`/api/public/shares/${encodeURIComponent(slug)}/attachments/`)) return value;
    const url = new URL(value, window.location.origin);
    url.searchParams.set("password", password);
    return `${url.pathname}${url.search}`;
  };
}

function markdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(markdownText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return markdownText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}
