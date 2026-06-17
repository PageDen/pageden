// Shared error-reporting bus. Vendor-neutral and self-contained — no
// external deps, no cloud references. Same file (and same call sites in
// product code) ships in the cloud overlay and the self-hosted build.
//
// Product code calls captureException() / captureMessage() / setUser()
// against this module. When no reporter is registered (every self-hosted
// build) every call is a cheap no-op.
//
// In the cloud build, main.tsx registers a Sentry-backed reporter at
// startup; the same calls then flow through to Sentry.

export type Severity = "info" | "warning" | "error" | "fatal" | "debug";

export type ErrorContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

export type ReporterUser = {
  id: string;
  email?: string;
  username?: string;
};

export type ErrorReporter = {
  captureException(error: unknown, context?: ErrorContext): void;
  captureMessage(message: string, level: Severity, context?: ErrorContext): void;
  setUser(user: ReporterUser | null): void;
};

let reporter: ErrorReporter | null = null;

/** Plug in a backend (e.g., Sentry). Pass null to unregister. */
export function registerErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/** Report an error to the registered backend, if any. Never throws. */
export function captureException(error: unknown, context?: ErrorContext): void {
  if (!reporter) return;
  try {
    reporter.captureException(error, context);
  } catch {
    // never throw from telemetry
  }
}

/** Report a freeform message at the given severity. Never throws. */
export function captureMessage(message: string, level: Severity = "info", context?: ErrorContext): void {
  if (!reporter) return;
  try {
    reporter.captureMessage(message, level, context);
  } catch {
    // never throw
  }
}

/** Associate the current session with a user; pass null to clear. */
export function setReporterUser(user: ReporterUser | null): void {
  if (!reporter) return;
  try {
    reporter.setUser(user);
  } catch {
    // never throw
  }
}
