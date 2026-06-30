import type { InputHTMLAttributes } from "react";
import { workspaceBaseDomain } from "../../lib/workspace-url";

type WorkspaceUrlInputProps = InputHTMLAttributes<HTMLInputElement>;

export function WorkspaceUrlInput({ className = "", ...props }: WorkspaceUrlInputProps) {
  return (
    <div className="flex h-10 items-center rounded-md border border-slate-300 bg-white transition focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-100 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-orange-400 dark:focus-within:ring-orange-500/20">
      <input
        className={`min-w-0 flex-1 bg-transparent px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 ${className}`}
        {...props}
      />
      <span className="flex h-full shrink-0 items-center border-l border-slate-200 px-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        .{workspaceBaseDomain}
      </span>
    </div>
  );
}
