import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import Link from "@tiptap/extension-link";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import {
  Bold,
  Code2,
  Download,
  ImageDown,
  ImageIcon,
  Film,
  Heading1,
  Heading2,
  Italic,
  AlignCenter,
  AlignLeft,
  AlignRight,
  LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  RotateCcw,
  Strikethrough,
  Table2,
  Trash2,
  Undo2,
} from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/button";
import {
  MAX_MEDIA_BYTES,
  classifyMediaUrl,
  isAllowedEmbedSrc,
  isUploadableType,
  normalizeEmbedUrl,
} from "./media";
import { UploadProgressToast, type UploadItem } from "../../components/ui/upload-progress-toast";

type RichMarkdownEditorProps = {
  documentId: string;
  value: string;
  onChange: (value: string) => void;
  live?: {
    websocketUrl: string;
    documentId: string;
    onStatus?: (status: "connecting" | "connected" | "disconnected") => void;
  };
};

type ImageAlign = "left" | "center" | "right";
type EditorNotice = { id: number; tone: "warning" | "error"; message: string };
type UrlPanelState = { kind: "link" | "media"; value: string };

type SelectedImageState = {
  src: string;
  width: string;
  height: string;
  displayWidth: string;
  displayHeight: string;
  align: ImageAlign;
  naturalWidth: number | null;
  naturalHeight: number | null;
  imageLeft: number;
  imageTop: number;
  imageWidth: number;
  imageHeight: number;
  toolbarLeft: number;
  toolbarTop: number;
};

type ImageResizeDrag = {
  side: "left" | "right";
  startX: number;
  startWidth: number;
  startHeight: number;
  ratio: number;
};

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});
turndown.use(gfm);
// Preserve embedded media as raw HTML through the Markdown round-trip (Markdown has no
// native video/iframe syntax). Images stay as ![](src).
turndown.keep(["video", "iframe"]);
turndown.addRule("pagedenImageLayout", {
  filter: (node) =>
    node.nodeName === "IMG" &&
    (Boolean((node as HTMLElement).getAttribute("width")) ||
      Boolean((node as HTMLElement).getAttribute("height")) ||
      ((node as HTMLElement).getAttribute("data-align") ?? "center") !== "center"),
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const src = element.getAttribute("src") ?? "";
    const alt = element.getAttribute("alt") ?? "";
    const title = element.getAttribute("title") ?? "";
    const width = element.getAttribute("width") ?? "";
    const height = element.getAttribute("height") ?? "";
    const align = element.getAttribute("data-align") ?? "center";
    const attrs = [
      ["src", src],
      ["alt", alt],
      ["title", title],
      ["width", width],
      ["height", height],
      ["data-align", align],
    ]
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name, value]) => `${name}="${escapeHtmlAttribute(value)}"`)
      .join(" ");
    return attrs ? `<img ${attrs}>` : "";
  },
});

const MediaImage = Image.extend<ImageOptions>({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute("width"),
        renderHTML: (attributes) => (attributes.width ? { width: attributes.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (element) => element.getAttribute("height"),
        renderHTML: (attributes) => (attributes.height ? { height: attributes.height } : {}),
      },
      "data-align": {
        default: "center",
        parseHTML: (element) => {
          const align = element.getAttribute("data-align");
          return align === "left" || align === "right" || align === "center" ? align : "center";
        },
        renderHTML: (attributes) => ({ "data-align": attributes["data-align"] ?? "center" }),
      },
    };
  },
});

// Uploaded video files -> an HTML5 <video> player. src must be http(s).
const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "video[src]",
        getAttrs: (el) => {
          const src = (el as HTMLElement).getAttribute("src") ?? "";
          return /^https?:\/\//i.test(src) ? { src } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(HTMLAttributes, { controls: "true", preload: "metadata", class: "pd-video" })];
  },
});

// External video embeds (YouTube / Vimeo only) -> a sandboxed iframe. Arbitrary iframe
// sources are rejected at parse time so a malicious doc can't smuggle one in.
const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "iframe[src]",
        getAttrs: (el) => {
          const src = (el as HTMLElement).getAttribute("src") ?? "";
          return isAllowedEmbedSrc(src) ? { src } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      { class: "pd-embed" },
      [
        "iframe",
        mergeAttributes(HTMLAttributes, {
          loading: "lazy",
          allowfullscreen: "true",
          referrerpolicy: "strict-origin-when-cross-origin",
          allow: "fullscreen; picture-in-picture; encrypted-media",
        }),
      ],
    ];
  },
});

export function RichMarkdownEditor({ documentId, value, onChange, live }: RichMarkdownEditorProps) {
  const lastSyncedMarkdown = useRef(value);
  const editorRef = useRef<Editor | null>(null);
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceImageInputRef = useRef<HTMLInputElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resizeDragRef = useRef<ImageResizeDrag | null>(null);
  const [selectedImage, setSelectedImage] = useState<SelectedImageState | null>(null);
  const [replaceImageMode, setReplaceImageMode] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [urlPanel, setUrlPanel] = useState<UrlPanelState | null>(null);

  const showNotice = useCallback((tone: EditorNotice["tone"], message: string) => {
    setNotice({ id: Date.now(), tone, message });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice((current) => (current?.id === notice.id ? null : current)), 4500);
    return () => window.clearTimeout(id);
  }, [notice]);

  const refreshSelectedImage = useCallback((ed: Editor | null = editorRef.current) => {
    const shell = shellRef.current;
    if (!ed || !shell) {
      setSelectedImage(null);
      return;
    }
    const { selection } = ed.state;
    const selectedNode = (selection as unknown as { node?: { type?: { name?: string }; attrs?: Record<string, unknown> } }).node;
    if (selectedNode?.type?.name !== "image") {
      setSelectedImage(null);
      return;
    }
    const dom = ed.view.nodeDOM(selection.from);
    const image = dom instanceof HTMLImageElement ? dom : dom instanceof HTMLElement ? dom.querySelector("img") : null;
    if (!image) {
      setSelectedImage(null);
      return;
    }
    const imageRect = image.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const attrs = selectedNode.attrs ?? {};
    const align = attrs["data-align"] === "left" || attrs["data-align"] === "right" || attrs["data-align"] === "center" ? attrs["data-align"] : "center";
    const renderedWidth = Math.round(imageRect.width);
    const renderedHeight = Math.round(imageRect.height);
    const width = attrs.width ? String(attrs.width) : "";
    const height = attrs.height ? String(attrs.height) : "";
    const measuredWidth = renderedWidth > 2 ? renderedWidth : image.naturalWidth || 0;
    const measuredHeight = renderedHeight > 2 ? renderedHeight : image.naturalHeight || 0;
    if (!width && !height && (!image.complete || renderedWidth <= 2 || renderedHeight <= 2)) {
      const refreshWhenLoaded = () => window.requestAnimationFrame(() => refreshSelectedImage(ed));
      image.addEventListener("load", refreshWhenLoaded, { once: true });
      window.setTimeout(refreshWhenLoaded, 100);
    }
    setSelectedImage({
      src: String(attrs.src ?? image.currentSrc ?? image.src ?? ""),
      width,
      height,
      displayWidth: width || (measuredWidth > 0 ? String(measuredWidth) : ""),
      displayHeight: height || (measuredHeight > 0 ? String(measuredHeight) : ""),
      align,
      naturalWidth: image.naturalWidth || null,
      naturalHeight: image.naturalHeight || null,
      imageLeft: imageRect.left - shellRect.left,
      imageTop: imageRect.top - shellRect.top,
      imageWidth: imageRect.width,
      imageHeight: imageRect.height,
      toolbarLeft: Math.max(12, imageRect.left - shellRect.left + imageRect.width / 2),
      toolbarTop: Math.max(12, imageRect.top - shellRect.top - 48),
    });
  }, []);

  // Upload uploadable files and insert image/video nodes. Stable (reads refs + stable setUploads)
  // so it can be referenced from editorProps handlers created at editor-construction time.
  const uploadAndInsert = useCallback(async (files: FileList | File[], at?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    for (const file of Array.from(files)) {
      if (!isUploadableType(file.type)) continue;
      if (file.size > MAX_MEDIA_BYTES) {
        showNotice("warning", `"${file.name}" exceeds the 25 MB limit.`);
        continue;
      }
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploads((prev) => [...prev, { id: uploadId, filename: file.name, progress: 0 }]);
      try {
        const attachment = await api.uploadAttachmentWithProgress(
          documentIdRef.current,
          file,
          (percent) => setUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress: percent } : u))),
        );
        const src = api.absoluteAttachmentUrl(attachment.id);
        const chain = ed.chain().focus();
        if (typeof at === "number") chain.setTextSelection(at);
        if (file.type.startsWith("image/")) chain.insertContent({ type: "image", attrs: { src, "data-align": "center" } }).run();
        else chain.insertContent({ type: "video", attrs: { src } }).run();
      } catch (err) {
        console.error("Upload failed:", err);
        showNotice("error", `Failed to upload "${file.name}".`);
      } finally {
        setUploads((prev) => prev.filter((u) => u.id !== uploadId));
      }
    }
  // setUploads is stable (React guarantee) — safe to omit from deps, keeping this callback stable.
  }, [showNotice]);

  const insertUrl = useCallback((raw: string): boolean => {
    const ed = editorRef.current;
    if (!ed) return false;
    const kind = classifyMediaUrl(raw);
    if (kind === "embed") {
      const src = normalizeEmbedUrl(raw);
      if (src) {
        ed.chain().focus().insertContent({ type: "embed", attrs: { src } }).run();
        return true;
      }
    } else if (kind === "image") {
      ed.chain().focus().insertContent({ type: "image", attrs: { src: raw.trim(), "data-align": "center" } }).run();
      return true;
    } else if (kind === "video") {
      ed.chain().focus().insertContent({ type: "video", attrs: { src: raw.trim() } }).run();
      return true;
    }
    return false;
  }, []);

  const liveConfig = useMemo(() => {
    if (!live) return null;
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(live.websocketUrl, live.documentId, ydoc, {
      connect: true,
      disableBc: true,
    });
    return { ydoc, provider, key: `${live.websocketUrl}:${live.documentId}` };
  }, [live?.documentId, live?.websocketUrl]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: false, undoRedo: liveConfig ? false : undefined }),
      ...(liveConfig ? [Collaboration.configure({ document: liveConfig.ydoc })] : []),
      Link.configure({ autolink: true, openOnClick: false, protocols: ["http", "https", "mailto"] }),
      MediaImage.configure({ allowBase64: false }),
      Video,
      Embed,
      Placeholder.configure({ placeholder: "Start writing..." }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    [liveConfig],
  );

  const editor = useEditor({
    extensions,
    content: liveConfig ? undefined : markdownToHtml(value),
    editorProps: {
      attributes: { "aria-label": "Document body", class: "min-h-full outline-none" },
      handlePaste: (_view, event) => {
        const files = event.clipboardData?.files;
        if (files && files.length && Array.from(files).some((f) => isUploadableType(f.type))) {
          void uploadAndInsert(files);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (text && classifyMediaUrl(text)) return insertUrl(text);
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (files && files.length && Array.from(files).some((f) => isUploadableType(f.type))) {
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void uploadAndInsert(files, pos);
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      const markdown = htmlToMarkdown(updatedEditor.getHTML());
      lastSyncedMarkdown.current = markdown;
      onChange(markdown);
      refreshSelectedImage(updatedEditor);
    },
    onSelectionUpdate: ({ editor: updatedEditor }) => {
      refreshSelectedImage(updatedEditor);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!liveConfig || !editor) return;
    let seeded = false;
    const seedIfEmpty = () => {
      if (seeded) return;
      seeded = true;
      if (!editor.getText().trim() && value.trim()) {
        editor.commands.setContent(markdownToHtml(value), { emitUpdate: true });
      }
    };
    const provider = liveConfig.provider;
    const handleSynced = (synced: boolean) => {
      if (synced) seedIfEmpty();
    };
    const handleStatus = (event: { status: "connected" | "disconnected" | "connecting" }) => {
      live?.onStatus?.(event.status);
      if (event.status === "connected" && provider.synced) seedIfEmpty();
    };
    provider.on("sync", handleSynced);
    provider.on("status", handleStatus);
    if (provider.synced) seedIfEmpty();
    return () => {
      provider.off("sync", handleSynced);
      provider.off("status", handleStatus);
    };
  }, [editor, live, liveConfig, value]);

  useEffect(() => {
    return () => {
      liveConfig?.provider.destroy();
      liveConfig?.ydoc.destroy();
    };
  }, [liveConfig]);

  useEffect(() => {
    if (!editor || liveConfig || value === lastSyncedMarkdown.current) return;
    lastSyncedMarkdown.current = value;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
  }, [editor, liveConfig, value]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    setUrlPanel({ kind: "link", value: previousUrl ?? "" });
  }, [editor]);

  const submitUrlPanel = useCallback((value: string) => {
    const raw = value.trim();
    if (urlPanel?.kind === "link") {
      if (!editor) return;
      if (!raw) {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href: raw }).run();
      }
      setUrlPanel(null);
      return;
    }
    if (urlPanel?.kind === "media") {
      if (!raw) {
        setUrlPanel(null);
        return;
      }
      if (insertUrl(raw)) setUrlPanel(null);
      else showNotice("warning", "That link is not a supported image, video, or YouTube/Vimeo URL.");
    }
  }, [editor, insertUrl, showNotice, urlPanel?.kind]);

  const pickFile = useCallback(() => fileInputRef.current?.click(), []);

  const updateSelectedImage = useCallback((attrs: Record<string, string | null>) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.chain().focus().updateAttributes("image", attrs).run();
    window.requestAnimationFrame(() => refreshSelectedImage(ed));
  }, [refreshSelectedImage]);

  const deleteSelectedImage = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.chain().focus().deleteSelection().run();
    setSelectedImage(null);
  }, []);

  const downloadSelectedImage = useCallback(() => {
    const src = selectedImage?.src;
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = src.split("/").pop()?.split("?")[0] || "image";
    a.rel = "noopener noreferrer";
    a.click();
  }, [selectedImage?.src]);

  const replaceSelectedImage = useCallback(() => {
    setReplaceImageMode(true);
    replaceImageInputRef.current?.click();
  }, []);

  const resetSelectedImageSize = useCallback(() => {
    updateSelectedImage({ width: null, height: null });
  }, [updateSelectedImage]);

  const startImageResize = useCallback((side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const image = selectedImage;
    if (!image) return;
    const startWidth = Math.max(1, Math.round(image.imageWidth));
    const startHeight = Math.max(1, Math.round(image.imageHeight));
    resizeDragRef.current = {
      side,
      startX: event.clientX,
      startWidth,
      startHeight,
      ratio: startHeight / startWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("pd-image-resizing");
  }, [selectedImage]);

  const resizeSelectedImage = useCallback((event: PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const nextWidth = Math.max(80, Math.round(drag.startWidth + (drag.side === "right" ? delta : -delta)));
    const nextHeight = Math.max(1, Math.round(nextWidth * drag.ratio));
    updateSelectedImage({ width: String(nextWidth), height: String(nextHeight) });
  }, [updateSelectedImage]);

  const stopImageResize = useCallback(() => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    document.body.classList.remove("pd-image-resizing");
    window.requestAnimationFrame(() => refreshSelectedImage());
  }, [refreshSelectedImage]);

  useEffect(() => {
    window.addEventListener("pointermove", resizeSelectedImage);
    window.addEventListener("pointerup", stopImageResize);
    window.addEventListener("pointercancel", stopImageResize);
    return () => {
      window.removeEventListener("pointermove", resizeSelectedImage);
      window.removeEventListener("pointerup", stopImageResize);
      window.removeEventListener("pointercancel", stopImageResize);
      document.body.classList.remove("pd-image-resizing");
    };
  }, [resizeSelectedImage, stopImageResize]);

  const insertEmbed = useCallback(() => {
    setUrlPanel({ kind: "media", value: "" });
  }, []);

  return (
    <div ref={shellRef} className="rich-markdown-editor relative flex h-full flex-col bg-white">
      <EditorToolbar editor={editor} onSetLink={setLink} onPickFile={pickFile} onInsertEmbed={insertEmbed} />
      <UploadProgressToast uploads={uploads} />
      <EditorNoticeToast notice={notice} onClose={() => setNotice(null)} />
      {urlPanel ? (
        <UrlPanel
          state={urlPanel}
          onChange={(nextValue) => setUrlPanel((current) => (current ? { ...current, value: nextValue } : current))}
          onCancel={() => setUrlPanel(null)}
          onSubmit={() => submitUrlPanel(urlPanel.value)}
        />
      ) : null}
      {selectedImage ? (
        <ImageBubbleToolbar
          image={selectedImage}
          onAlign={(align) => updateSelectedImage({ "data-align": align })}
          onWidth={(width) => updateSelectedImage({ width: width.trim() || null })}
          onHeight={(height) => updateSelectedImage({ height: height.trim() || null })}
          onReset={resetSelectedImageSize}
          onResizeStart={startImageResize}
          onDownload={downloadSelectedImage}
          onReplace={replaceSelectedImage}
          onDelete={deleteSelectedImage}
        />
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void uploadAndInsert(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={replaceImageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          const file = files?.[0];
          if (file && replaceImageMode) {
            const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setUploads((prev) => [...prev, { id: uploadId, filename: file.name, progress: 0 }]);
            void (async () => {
              try {
                const attachment = await api.uploadAttachmentWithProgress(
                  documentIdRef.current,
                  file,
                  (percent) => setUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress: percent } : u))),
                );
                updateSelectedImage({ src: api.absoluteAttachmentUrl(attachment.id) });
              } catch (err) {
                console.error("Replace image upload failed:", err);
                showNotice("error", `Failed to upload "${file.name}".`);
              } finally {
                setUploads((prev) => prev.filter((u) => u.id !== uploadId));
                setReplaceImageMode(false);
              }
            })();
          }
          e.target.value = "";
        }}
      />
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-8" />
    </div>
  );
}

function EditorNoticeToast({ notice, onClose }: { notice: EditorNotice | null; onClose: () => void }) {
  if (!notice) return null;
  const classes =
    notice.tone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div aria-live="polite" className="fixed right-6 top-24 z-50 w-[min(92vw,360px)]">
      <div className={`rounded-lg border px-4 py-3 text-sm leading-6 shadow-xl ${classes}`}>
        <div className="flex items-start justify-between gap-3">
          <p>{notice.message}</p>
          <button type="button" className="shrink-0 rounded px-1 font-semibold opacity-70 hover:opacity-100" onClick={onClose} aria-label="Dismiss notice">
            x
          </button>
        </div>
      </div>
    </div>
  );
}

function UrlPanel({
  state,
  onChange,
  onCancel,
  onSubmit,
}: {
  state: UrlPanelState;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const title = state.kind === "link" ? "Add link" : "Embed media";
  const help = state.kind === "link" ? "Paste a URL, or leave it empty to remove the current link." : "Paste a YouTube, Vimeo, image, or video URL.";
  const placeholder = state.kind === "link" ? "https://example.com" : "https://youtube.com/watch?v=...";
  return (
    <div className="absolute left-1/2 top-14 z-40 w-[min(92vw,520px)] -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-2xl">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div>
          <div className="font-semibold text-slate-950">{title}</div>
          <p className="mt-1 text-slate-500">{help}</p>
        </div>
        <input
          autoFocus
          value={state.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm text-slate-950 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">{state.kind === "link" ? "Apply link" : "Insert media"}</Button>
        </div>
      </form>
    </div>
  );
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

export function htmlToMarkdown(html: string): string {
  const markdown = turndown.turndown(html).trimEnd();
  return markdown ? `${markdown}\n` : "";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ImageBubbleToolbar({
  image,
  onAlign,
  onWidth,
  onHeight,
  onReset,
  onResizeStart,
  onDownload,
  onReplace,
  onDelete,
}: {
  image: SelectedImageState;
  onAlign: (align: ImageAlign) => void;
  onWidth: (width: string) => void;
  onHeight: (height: string) => void;
  onReset: () => void;
  onResizeStart: (side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => void;
  onDownload: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Resize image left"
        title="Resize image left"
        className="pd-image-resize-handle pd-image-resize-handle-left"
        style={{
          left: image.imageLeft,
          top: image.imageTop + image.imageHeight / 2,
        }}
        onPointerDown={(event) => onResizeStart("left", event)}
      />
      <button
        type="button"
        aria-label="Resize image right"
        title="Resize image right"
        className="pd-image-resize-handle pd-image-resize-handle-right"
        style={{
          left: image.imageLeft + image.imageWidth,
          top: image.imageTop + image.imageHeight / 2,
        }}
        onPointerDown={(event) => onResizeStart("right", event)}
      />
      <div
        className="absolute z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm shadow-xl"
        style={{ left: image.toolbarLeft, top: image.toolbarTop }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <ToolbarButton label="Align image left" active={image.align === "left"} onClick={() => onAlign("left")}>
          <AlignLeft size={16} />
        </ToolbarButton>
        <ToolbarButton label="Align image center" active={image.align === "center"} onClick={() => onAlign("center")}>
          <AlignCenter size={16} />
        </ToolbarButton>
        <ToolbarButton label="Align image right" active={image.align === "right"} onClick={() => onAlign("right")}>
          <AlignRight size={16} />
        </ToolbarButton>
        <ToolbarDivider />
        <label className="flex items-center gap-1 px-1 text-xs text-slate-500">
          <span className="sr-only">Image width</span>
          <input
            aria-label="Image width"
            inputMode="numeric"
            className="h-8 w-16 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
            placeholder="W"
            value={image.displayWidth}
            onChange={(event) => onWidth(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        <span className="text-slate-400">×</span>
        <label className="flex items-center gap-1 px-1 text-xs text-slate-500">
          <span className="sr-only">Image height</span>
          <input
            aria-label="Image height"
            inputMode="numeric"
            className="h-8 w-16 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
            placeholder="H"
            value={image.displayHeight}
            onChange={(event) => onHeight(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        <ToolbarDivider />
        <ToolbarButton label="Download image" onClick={onDownload}>
          <Download size={16} />
        </ToolbarButton>
        <ToolbarButton label="Replace image" onClick={onReplace}>
          <ImageDown size={16} />
        </ToolbarButton>
        <ToolbarButton label="Reset image size" onClick={onReset}>
          <RotateCcw size={16} />
        </ToolbarButton>
        <ToolbarButton label="Delete image" onClick={onDelete}>
          <Trash2 size={16} />
        </ToolbarButton>
      </div>
    </>
  );
}

function EditorToolbar({
  editor,
  onSetLink,
  onPickFile,
  onInsertEmbed,
}: {
  editor: Editor | null;
  onSetLink: () => void;
  onPickFile: () => void;
  onInsertEmbed: () => void;
}) {
  return (
    <div className="border-b border-slate-200 bg-slate-50/80 px-8 py-2">
      <div className="mx-auto flex max-w-[920px] flex-wrap items-center gap-1">
        <ToolbarButton label="Bold" active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold size={16} />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic size={16} />
        </ToolbarButton>
        <ToolbarButton label="Strikethrough" active={editor?.isActive("strike")} onClick={() => editor?.chain().focus().toggleStrike().run()}>
          <Strikethrough size={16} />
        </ToolbarButton>
        <ToolbarButton label="Inline code" active={editor?.isActive("code")} onClick={() => editor?.chain().focus().toggleCode().run()}>
          <Code2 size={16} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Heading 1" active={editor?.isActive("heading", { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={16} />
        </ToolbarButton>
        <ToolbarButton label="Heading 2" active={editor?.isActive("heading", { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 size={16} />
        </ToolbarButton>
        <ToolbarButton label="Quote" active={editor?.isActive("blockquote")} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
          <Quote size={16} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Bulleted list" active={editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          <List size={16} />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" active={editor?.isActive("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered size={16} />
        </ToolbarButton>
        <ToolbarButton label="Task list" active={editor?.isActive("taskList")} onClick={() => editor?.chain().focus().toggleTaskList().run()}>
          <ListTodo size={16} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Link" active={editor?.isActive("link")} onClick={onSetLink}>
          <LinkIcon size={16} />
        </ToolbarButton>
        <ToolbarButton label="Insert image or video" onClick={onPickFile} accent>
          <ImageIcon size={16} />
        </ToolbarButton>
        <ToolbarButton label="Embed video (YouTube/Vimeo) or media URL" onClick={onInsertEmbed} accent>
          <Film size={16} />
        </ToolbarButton>
        <ToolbarButton label="Table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <Table2 size={16} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton label="Undo" onClick={() => editor?.chain().focus().undo().run()}>
          <Undo2 size={16} />
        </ToolbarButton>
        <ToolbarButton label="Redo" onClick={() => editor?.chain().focus().redo().run()}>
          <Redo2 size={16} />
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  children,
  label,
  onClick,
  accent,
}: {
  active?: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${
        accent
          ? active
            ? "border-orange-300 bg-orange-50 text-orange-700 shadow-sm"
            : "border-orange-200 text-orange-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
          : `text-slate-600 ${
              active ? "border-slate-300 bg-white text-slate-950 shadow-sm" : "border-transparent hover:border-slate-300 hover:bg-white hover:text-slate-900"
            }`
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div aria-hidden="true" className="mx-1 h-6 w-px bg-slate-200" />;
}
