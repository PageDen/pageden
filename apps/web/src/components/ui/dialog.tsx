import { useEffect, type ReactNode } from "react";

export function Dialog({
  title,
  onClose,
  children,
  size = "sm",
  className = "",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "lg";
  className?: string;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[1px]" onClick={onClose}>
      <div
        className={`w-full ${size === "lg" ? "max-w-lg" : "max-w-sm"} rounded-lg border border-slate-200 bg-white p-5 shadow-xl ${className}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 min-w-0 break-words text-base font-semibold leading-6 text-slate-950">{title}</h2>
        {children}
      </div>
    </div>
  );
}
