import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Check, Clipboard } from "lucide-react";
import type { z } from "zod";
import type { attachmentListSchema, treeSchema } from "@pageden/api-types";
import { api } from "../../lib/api";
import { treeQuery } from "../../lib/queries";
import { createHeadingIdGenerator } from "./table-of-contents";
import { parseFrontmatter } from "./frontmatter";
import { renderDecisionBlocks } from "./decision-blocks";
import { relatedDocLinksForValue, resolveWikiLinks } from "./obsidian-links";
import { isAllowedEmbedSrc } from "./media";
import { previewSanitizeSchema, rehypeAllowlistIframes } from "./media-sanitize";

type Tree = z.infer<typeof treeSchema>;
type AttachmentList = z.infer<typeof attachmentListSchema>;

export function DocumentMarkdownPreview({
  content,
  documentId,
  workspaceId,
  className = "",
}: {
  content: string;
  documentId: string;
  workspaceId: string;
  className?: string;
}) {
  const tree = useQuery({ ...treeQuery(workspaceId), enabled: workspaceId !== "" });
  const attachments = useQuery({
    queryKey: ["attachments", documentId],
    queryFn: () => api.attachments(documentId),
    enabled: documentId !== "",
  });
  const parsed = useMemo(() => parseFrontmatter(content), [content]);
  const decisionRender = useMemo(() => renderDecisionBlocks(parsed.body), [parsed.body]);
  const previewContent = useMemo(
    () => resolveWikiLinks(decisionRender.body, workspaceId, tree.data),
    [decisionRender.body, tree.data, workspaceId],
  );
  const attachmentUrls = useMemo(() => buildAttachmentUrlMap(attachments.data), [attachments.data]);
  const headingIdFor = createHeadingIdGenerator();

  return (
    <article className={["pageden-document-view prose prose-slate max-w-none break-words text-[16px] leading-8 dark:prose-invert sm:text-[15px] sm:leading-7", className].filter(Boolean).join(" ")}>
      <FrontmatterSummary attributes={parsed.attributes} workspaceId={workspaceId} tree={tree.data} />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSanitizeSchema], rehypeAllowlistIframes]}
        components={{
          a: ({ href, children, className: linkClass, ...props }) => {
            const resolved = href ? attachmentUrls.get(cleanAttachmentHref(href)) : undefined;
            const linkClassName = [
              "font-medium text-orange-700 underline decoration-orange-300 underline-offset-4 transition hover:text-orange-800 hover:decoration-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300",
              linkClass,
            ].filter(Boolean).join(" ");
            return <a {...props} href={resolved ?? href} className={linkClassName}>{children}</a>;
          },
          img: ({ src, alt, ...props }) => {
            const resolved = src ? attachmentUrls.get(cleanAttachmentHref(src)) : undefined;
            const align = imageAlign(props);
            return <img {...props} src={resolved ?? src} alt={alt ?? ""} data-align={align} className="max-w-full rounded" />;
          },
          video: ({ ...props }) => (
            <video {...props} controls className="max-w-full rounded" />
          ),
          pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
          table: ({ children, ...props }) => (
            <div className="pageden-table-scroll">
              <table {...props}>{children}</table>
            </div>
          ),
          h1: ({ children, ...props }) => <h1 {...props} id={headingIdFor(markdownText(children))}>{children}</h1>,
          h2: ({ children, ...props }) => <h2 {...props} id={headingIdFor(markdownText(children))}>{children}</h2>,
          h3: ({ children, ...props }) => <h3 {...props} id={headingIdFor(markdownText(children))}>{children}</h3>,
          h4: ({ children, ...props }) => <h4 {...props} id={headingIdFor(markdownText(children))}>{children}</h4>,
          h5: ({ children, ...props }) => <h5 {...props} id={headingIdFor(markdownText(children))}>{children}</h5>,
          h6: ({ children, ...props }) => <h6 {...props} id={headingIdFor(markdownText(children))}>{children}</h6>,
          iframe: ({ src, ...props }) =>
            src && isAllowedEmbedSrc(src) ? (
              <span className="block aspect-video w-full max-w-2xl overflow-hidden rounded">
                <iframe {...props} src={src} className="h-full w-full" allowFullScreen title="Embedded media" />
              </span>
            ) : null,
        }}
      >
        {previewContent}
      </ReactMarkdown>
    </article>
  );
}

function FrontmatterSummary({
  attributes,
  workspaceId,
  tree,
}: {
  attributes: Record<string, string | string[] | boolean | number>;
  workspaceId: string;
  tree?: Pick<Tree, "documents">;
}) {
  const entries = Object.entries(attributes).filter(([key]) => key !== "title");
  if (entries.length === 0) return null;
  return (
    <dl className="mb-6 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{key}</dt>
          <dd className="mt-0.5 min-w-0 text-slate-700">
            {isRelatedDocsKey(key) ? (
              <RelatedDocsFrontmatterValue value={value} workspaceId={workspaceId} tree={tree} />
            ) : (
              <span className="block truncate">{Array.isArray(value) ? value.join(", ") : String(value)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RelatedDocsFrontmatterValue({
  value,
  workspaceId,
  tree,
}: {
  value: string | string[] | boolean | number;
  workspaceId: string;
  tree?: Pick<Tree, "documents">;
}) {
  const links = relatedDocLinksForValue(value, workspaceId, tree);
  if (links.length === 0) return <span className="block truncate">{String(value)}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {links.map((link) =>
        link.href ? (
          <Link
            key={`${link.target}-${link.href}`}
            to={link.href}
            className="inline-flex max-w-full items-center rounded-md border border-orange-200 bg-white px-2 py-0.5 text-xs font-medium text-orange-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800"
            title={link.target}
          >
            <span className="truncate">{link.label}</span>
          </Link>
        ) : (
          <span
            key={link.target}
            className="inline-flex max-w-full items-center rounded-md border border-dashed border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-500"
            title={`Unresolved related doc: ${link.target}`}
          >
            <span className="truncate">{link.label}</span>
          </span>
        ),
      )}
    </span>
  );
}

function isRelatedDocsKey(key: string): boolean {
  return key.toLowerCase() === "relateddocs" || key.toLowerCase() === "related_docs";
}

function CopyableCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = markdownText(children).replace(/\n$/, "");

  async function copyCode() {
    await copyTextToClipboard(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="pageden-code-block group">
      <button
        type="button"
        className="pageden-code-copy-button"
        onClick={() => void copyCode()}
        aria-label={copied ? "Copied code" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={15} /> : <Clipboard size={15} />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function markdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(markdownText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return markdownText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function imageAlign(props: Record<string, unknown>) {
  const align = props["data-align"] ?? props.dataAlign;
  return align === "left" || align === "right" || align === "center" ? align : undefined;
}

function buildAttachmentUrlMap(data?: AttachmentList): Map<string, string> {
  const out = new Map<string, string>();
  for (const attachment of data?.attachments ?? []) {
    const url = api.attachmentUrl(attachment.id);
    out.set(attachment.filename, url);
    out.set(encodeURI(attachment.filename), url);
  }
  return out;
}

function cleanAttachmentHref(href: string): string {
  const withoutHash = href.split("#")[0] ?? href;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  const filename = withoutQuery.split("/").pop() ?? withoutQuery;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
