import { afterEach, describe, expect, it, vi } from "vitest";
import { createMailer } from "./mailer.js";

const origKey = process.env.RESEND_API_KEY;
const origBrevoKey = process.env.BREVO_API_KEY;
const origProvider = process.env.EMAIL_PROVIDER;
const origFrom = process.env.MAIL_FROM;
afterEach(() => {
  if (origKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = origKey;
  if (origBrevoKey === undefined) delete process.env.BREVO_API_KEY;
  else process.env.BREVO_API_KEY = origBrevoKey;
  if (origProvider === undefined) delete process.env.EMAIL_PROVIDER;
  else process.env.EMAIL_PROVIDER = origProvider;
  if (origFrom === undefined) delete process.env.MAIL_FROM;
  else process.env.MAIL_FROM = origFrom;
  vi.restoreAllMocks();
});

describe("createMailer", () => {
  it("dev fallback logs the links when no provider key is set", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.BREVO_API_KEY;
    delete process.env.EMAIL_PROVIDER;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mailer = createMailer();
    await mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x");
    await mailer.sendEmailVerification("a@t.co", "https://app/verify?token=y");
    await mailer.sendPermissionGranted("a@t.co", {
      actorName: "Chris",
      workspaceName: "Pageden workspace",
      resourceType: "document",
      resourceName: "Roadmap",
      role: "editor",
      openUrl: "https://app/w/ws/p/Roadmap",
    });
    await mailer.sendCommentMentioned("a@t.co", {
      actorName: "Chris <script>",
      actorEmail: "chris@t.co",
      workspaceName: "Pageden workspace",
      documentTitle: "Roadmap",
      documentPath: "docs/roadmap.md",
      commentBody: "<review this>",
      openUrl: "https://app/w/ws/p/Roadmap#comment-1",
    });
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[0]![0]).toContain("https://app/reset?token=x");
    expect(log.mock.calls[2]![0]).toContain("https://app/w/ws/p/Roadmap");
    expect(log.mock.calls[3]![0]).toContain("#comment-1");
  });

  it("uses the Resend API when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "resend-test-key-not-real";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = createMailer();
    await mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x");
    await mailer.sendEmailVerification("a@t.co", "https://app/verify?token=y");
    await mailer.sendPermissionGranted("a@t.co", {
      actorName: "Chris",
      workspaceName: "Pageden workspace",
      resourceType: "folder",
      resourceName: "Plans",
      role: "viewer",
      openUrl: "https://app/w/ws",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("Pageden/1.0");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("a@t.co");
    const permissionBody = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string);
    expect(permissionBody.subject).toContain("shared a folder");
    expect(permissionBody.html).toContain("https://app/w/ws");

    await mailer.sendPermissionGranted("a@t.co", {
      actorName: "Chris",
      workspaceName: "Pageden workspace",
      resourceType: "document",
      resourceName: "Strategy",
      role: "manager",
      openUrl: "https://app/w/ws/p/strategy",
    });
    await mailer.sendCommentMentioned("a@t.co", {
      actorName: "",
      actorEmail: "agent@t.co",
      workspaceName: "Pageden workspace",
      documentTitle: "Strategy",
      commentBody: "x".repeat(600),
      openUrl: "https://app/w/ws/p/strategy#comment-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const managerBody = JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string);
    expect(managerBody.text).toContain("as Manager");
    const mentionBody = JSON.parse((fetchMock.mock.calls[4]![1] as RequestInit).body as string);
    expect(mentionBody.subject).toContain("agent@t.co mentioned you");
    expect(mentionBody.text).toContain("x".repeat(500));
    expect(mentionBody.text).not.toContain("x".repeat(501));
  });

  it("uses the Brevo API when BREVO_API_KEY is set", async () => {
    process.env.BREVO_API_KEY = "brevo-test-key-not-real";
    process.env.MAIL_FROM = "Pageden <no-reply@pageden.app>";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));
    const mailer = createMailer();
    await mailer.sendEmailVerification("a@t.co", "https://app/verify?token=y");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.brevo.com/v3/smtp/email");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["api-key"]).toBe("brevo-test-key-not-real");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("Pageden/1.0");
    const body = JSON.parse(init.body as string);
    expect(body.sender).toEqual({ name: "Pageden", email: "no-reply@pageden.app" });
    expect(body.to).toEqual([{ email: "a@t.co" }]);
    expect(body.htmlContent).toContain("https://app/verify?token=y");

    await mailer.sendCommentMentioned("b@t.co", {
      actorName: "Chris",
      workspaceName: "Workspace & Co",
      documentTitle: "Doc <One>",
      documentPath: "folder/doc.md",
      commentBody: "<hello>",
      openUrl: "https://app/comment",
    });
    const mention = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(mention.htmlContent).toContain("Workspace &amp; Co");
    expect(mention.htmlContent).toContain("Doc &lt;One&gt;");
    expect(mention.htmlContent).toContain("&lt;hello&gt;");
  });

  it("uses EMAIL_PROVIDER to choose Resend when both provider keys exist", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.BREVO_API_KEY = "brevo-test-key-not-real";
    process.env.RESEND_API_KEY = "resend-test-key-not-real";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = createMailer();
    await mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
  });

  it("throws when Resend returns a non-2xx status", async () => {
    process.env.RESEND_API_KEY = "resend-test-key-not-real";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 422 }));
    const mailer = createMailer();
    await expect(mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x")).rejects.toThrow();
  });

  it("throws when Brevo returns a non-2xx status", async () => {
    process.env.BREVO_API_KEY = "brevo-test-key-not-real";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    const mailer = createMailer();
    await expect(mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x")).rejects.toThrow("Brevo responded 401");
  });
});
