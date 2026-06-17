import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "./input";
import { Button } from "./button";

export type ComboboxRole = "viewer" | "editor" | "manager";

interface UserRow {
  id: string;
  email: string;
  name: string;
}

interface GroupRow {
  id: string;
  name: string;
  slug: string;
}

interface Existing {
  subjectType: "user" | "group";
  subjectId: string;
}

type Option =
  | { kind: "user"; id: string; email: string; name: string }
  | { kind: "group"; id: string; name: string }
  | { kind: "invite"; email: string };

interface Props {
  users: UserRow[];
  groups: GroupRow[];
  existing: Existing[];
  role: ComboboxRole;
  onRoleChange: (role: ComboboxRole) => void;
  onAddExisting: (subjectType: "user" | "group", subjectId: string) => void;
  onInviteEmail: (email: string) => void;
  isInviting?: boolean;
  /** Label shown on the input field. */
  label?: string;
  /** Helper text below the input. */
  helper?: string;
}

// Combined picker that searches existing workspace users + groups, and offers
// an "Invite by email" branch when the input looks like a new email address.
// Replaces the legacy two-input split (separate "share by email" form +
// "Add" dropdown) from the permissions dialog.
export function PeopleCombobox({
  users,
  groups,
  existing,
  role,
  onRoleChange,
  onAddExisting,
  onInviteEmail,
  isInviting = false,
  label = "Add people, groups, or invite by email",
  helper,
}: Props) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const inputId = useId();

  const taken = useMemo(() => new Set(existing.map((e) => `${e.subjectType}:${e.subjectId}`)), [existing]);

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const userMatches: Option[] = users
      .filter((u) => !taken.has(`user:${u.id}`))
      .filter((u) => {
        if (!q) return false;
        return u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q);
      })
      .slice(0, 6)
      .map((u) => ({ kind: "user", id: u.id, email: u.email, name: u.name }));
    const groupMatches: Option[] = groups
      .filter((g) => !taken.has(`group:${g.id}`))
      .filter((g) => {
        if (!q) return false;
        return g.name.toLowerCase().includes(q) || g.slug.toLowerCase().includes(q);
      })
      .slice(0, 4)
      .map((g) => ({ kind: "group", id: g.id, name: g.name }));
    // Synthetic "Invite alice@x.com" row only when the query is a plausible
    // email AND we have no exact user match — otherwise it competes with the
    // real user row.
    const showInvite = isValidEmail(q) && !users.some((u) => u.email.toLowerCase() === q);
    const inviteOption: Option[] = showInvite ? [{ kind: "invite", email: q }] : [];
    return [...userMatches, ...groupMatches, ...inviteOption];
  }, [users, groups, taken, query]);

  // Keep activeIndex in range after option list changes.
  useEffect(() => {
    if (activeIndex >= options.length) setActiveIndex(0);
  }, [options.length, activeIndex]);

  // Close on click-outside.
  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [isOpen]);

  function commit(option: Option) {
    if (option.kind === "user") onAddExisting("user", option.id);
    else if (option.kind === "group") onAddExisting("group", option.id);
    else onInviteEmail(option.email);
    setQuery("");
    setIsOpen(false);
    setActiveIndex(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length === 0) return;
      setIsOpen(true);
      setActiveIndex((idx) => (idx + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      setIsOpen(true);
      setActiveIndex((idx) => (idx - 1 + options.length) % options.length);
    } else if (event.key === "Enter") {
      if (options.length === 0) return;
      event.preventDefault();
      const option = options[activeIndex] ?? options[0]!;
      commit(option);
    } else if (event.key === "Escape") {
      setIsOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div>
        <label className="text-sm font-medium text-slate-700" htmlFor={inputId}>
          {label}
        </label>
        {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_8rem]">
        <div className="relative">
          <Input
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={isOpen && options.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={isOpen && options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
            placeholder="Search by name or email"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIsOpen(true);
              setActiveIndex(0);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={onKeyDown}
            disabled={isInviting}
          />
          {isOpen && options.length > 0 ? (
            <ul
              id={listboxId}
              role="listbox"
              className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
            >
              {options.map((option, index) => (
                <li
                  key={optionKey(option)}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                    index === activeIndex ? "bg-orange-50 text-slate-900" : "text-slate-700 hover:bg-slate-50"
                  }`}
                  onMouseDown={(event) => {
                    // mousedown so we beat the input's blur from closing the list.
                    event.preventDefault();
                    commit(option);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <OptionRow option={option} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <select
          aria-label="Role"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          value={role}
          onChange={(event) => onRoleChange(event.target.value as ComboboxRole)}
          disabled={isInviting}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="manager">Manager</option>
        </select>
      </div>
      {isInviting ? (
        <p className="text-xs text-slate-500" aria-live="polite">
          Inviting…
        </p>
      ) : null}
      {/* The trailing Button is intentionally omitted: every option commits on click/Enter. */}
      <noscript>
        <Button disabled>JavaScript is required to add people.</Button>
      </noscript>
    </div>
  );
}

function OptionRow({ option }: { option: Option }) {
  if (option.kind === "user") {
    return (
      <>
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-600">
          {initialFor(option.name || option.email)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-900">{option.name || option.email}</span>
          {option.name ? <span className="block truncate text-xs text-slate-500">{option.email}</span> : null}
        </span>
      </>
    );
  }
  if (option.kind === "group") {
    return (
      <>
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-medium text-indigo-600">
          {initialFor(option.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-900">{option.name}</span>
          <span className="block truncate text-xs text-slate-500">Group</span>
        </span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-medium text-emerald-600">
        +
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-900">Invite {option.email}</span>
        <span className="block truncate text-xs text-slate-500">Adds them as a guest of this workspace.</span>
      </span>
    </>
  );
}

function optionKey(option: Option): string {
  if (option.kind === "user") return `user:${option.id}`;
  if (option.kind === "group") return `group:${option.id}`;
  return `invite:${option.email}`;
}

function initialFor(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

// Lightweight email shape check — same intent as the server-side
// isValidEmailShape in routes.ts: one '@', a dot in the domain, no whitespace,
// no control characters. Linear scan to avoid the polynomial-redos pattern.
export function isValidEmail(value: string): boolean {
  if (!value || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1) return false;
  if (value.indexOf("@", at + 1) !== -1) return false;
  const domain = value.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  if (lastDot < 1 || lastDot === domain.length - 1) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 32) return false;
  }
  return true;
}
