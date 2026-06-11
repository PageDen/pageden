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
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toContain("https://app/reset?token=x");
  });

  it("uses the Resend API when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "resend-test-key-not-real";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = createMailer();
    await mailer.sendPasswordReset("a@t.co", "https://app/reset?token=x");
    await mailer.sendEmailVerification("a@t.co", "https://app/verify?token=y");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("Pageden/1.0");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("a@t.co");
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
