// Transactional email. Uses Brevo or Resend when configured; otherwise a dev fallback logs the
// link so local development needs no email provider. Injectable so tests can capture messages
// without hitting the network.
export interface Mailer {
  sendPasswordReset(to: string, resetUrl: string): Promise<void>;
  sendEmailVerification(to: string, verifyUrl: string): Promise<void>;
  sendPermissionGranted(to: string, input: PermissionGrantedEmail): Promise<void>;
}

export interface PermissionGrantedEmail {
  actorName: string;
  actorEmail?: string;
  workspaceName: string;
  resourceType: "document" | "folder";
  resourceName: string;
  role: "viewer" | "editor" | "manager";
  openUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: from.trim() };
  const name = match[1]?.trim();
  return { name: name || undefined, email: match[2]!.trim() };
}

function roleLabel(role: PermissionGrantedEmail["role"]): string {
  if (role === "viewer") return "Viewer";
  if (role === "editor") return "Editor";
  return "Manager";
}

function permissionGrantedMessage(input: PermissionGrantedEmail): { subject: string; text: string; html: string } {
  const actor = input.actorName || input.actorEmail || "A workspace manager";
  const role = roleLabel(input.role);
  const resourceLabel = input.resourceType === "folder" ? "folder" : "document";
  const subject = `${actor} shared a ${resourceLabel} with you in Pageden`;
  const text = [
    `${actor} shared "${input.resourceName}" with you as ${role} in ${input.workspaceName}.`,
    "",
    "Open it in Pageden:",
    input.openUrl,
    "",
    "If you were not expecting this, you can ignore this email.",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(actor)} shared <strong>${escapeHtml(input.resourceName)}</strong> with you as <strong>${escapeHtml(role)}</strong> in ${escapeHtml(input.workspaceName)}.</p>`,
    `<p><a href="${escapeHtml(input.openUrl)}">Open in Pageden</a></p>`,
    "<p>If you were not expecting this, you can ignore this email.</p>",
  ].join("");
  return { subject, text, html };
}

async function sendResend(apiKey: string, from: string, to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "Pageden/1.0" },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

async function sendBrevo(apiKey: string, from: string, to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "api-key": apiKey, "content-type": "application/json", "user-agent": "Pageden/1.0" },
    body: JSON.stringify({
      sender: parseSender(from),
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo responded ${res.status}`);
}

export function createMailer(): Mailer {
  const provider = (process.env.EMAIL_PROVIDER ?? (process.env.BREVO_API_KEY ? "brevo" : process.env.RESEND_API_KEY ? "resend" : "log")).toLowerCase();
  const brevoKey = process.env.BREVO_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM ?? "Pageden <no-reply@pageden.local>";
  const send =
    provider === "brevo" && brevoKey
      ? (to: string, subject: string, text: string, html: string) => sendBrevo(brevoKey, from, to, subject, text, html)
      : provider === "resend" && resendKey
        ? (to: string, subject: string, text: string, html: string) => sendResend(resendKey, from, to, subject, text, html)
        : null;

  if (!send) {
    return {
      async sendPasswordReset(to, resetUrl) {
        console.log(`[mailer:dev] password reset for ${to}: ${resetUrl}`);
      },
      async sendEmailVerification(to, verifyUrl) {
        console.log(`[mailer:dev] verify email for ${to}: ${verifyUrl}`);
      },
      async sendPermissionGranted(to, input) {
        console.log(`[mailer:dev] permission grant for ${to}: ${input.openUrl}`);
      },
    };
  }
  return {
    async sendPasswordReset(to, resetUrl) {
      await send(
        to,
        "Reset your Pageden password",
        `Reset your password using this link (valid for 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        `<p>Reset your Pageden password using the link below (valid for 1 hour):</p><p><a href="${escapeHtml(resetUrl)}">Reset password</a></p><p>If you didn't request this, you can ignore this email.</p>`,
      );
    },
    async sendEmailVerification(to, verifyUrl) {
      await send(
        to,
        "Verify your Pageden email",
        `Confirm your email address using this link:\n\n${verifyUrl}`,
        `<p>Confirm your Pageden email address:</p><p><a href="${escapeHtml(verifyUrl)}">Verify email</a></p>`,
      );
    },
    async sendPermissionGranted(to, input) {
      const message = permissionGrantedMessage(input);
      await send(to, message.subject, message.text, message.html);
    },
  };
}

let mailer: Mailer = createMailer();
export function getMailer(): Mailer {
  return mailer;
}
export function setMailer(next: Mailer): void {
  mailer = next;
}
