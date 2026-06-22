import { FileUp, ShieldCheck } from "lucide-react";

export type UploadItem = {
  id: string;
  filename: string;
  progress: number; // 0-100
  scanning?: boolean; // true while awaiting ClamAV result
};

/**
 * Fixed bottom-right panel showing in-progress file uploads.
 * Matches Outline's "Uploading... X%" pattern but styled for Pageden.
 */
export function UploadProgressToast({ uploads }: { uploads: UploadItem[] }) {
  if (uploads.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Upload progress"
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2"
    >
      {uploads.map((item) => (
        <div
          key={item.id}
          className="flex w-72 items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-lg"
        >
          {item.scanning ? (
            <ShieldCheck size={16} className="shrink-0 animate-pulse text-blue-500" />
          ) : (
            <FileUp size={16} className="shrink-0 text-orange-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-slate-700" title={item.filename}>
                {item.filename}
              </span>
              {item.scanning ? (
                <span className="shrink-0 text-xs text-blue-500">Scanning…</span>
              ) : (
                <span className="shrink-0 text-xs tabular-nums text-slate-400">
                  {item.progress}%
                </span>
              )}
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all duration-150 ${item.scanning ? "w-full animate-pulse bg-blue-400" : "bg-orange-500"}`}
                style={item.scanning ? undefined : { width: `${item.progress}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
