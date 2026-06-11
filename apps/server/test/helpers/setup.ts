// Runs before each integration test file. Raises rate limits so fixtures/most tests never
// trip them (the dedicated rate-limit test builds its own app with a low limit), and points
// storage at a temp dir. Required secrets/DATABASE_URL come from the environment (CI/local).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RATE_LIMIT_MAX ??= "1000000";
process.env.LOGIN_RATE_LIMIT_MAX ??= "1000000";
process.env.REINDEX_RATE_LIMIT_MAX ??= "1000000";
process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX ??= "1000000";
process.env.FORGOT_PASSWORD_RATE_LIMIT_MAX ??= "1000000";
process.env.RESET_PASSWORD_RATE_LIMIT_MAX ??= "1000000";
process.env.REGISTER_RATE_LIMIT_MAX ??= "1000000";
process.env.VERIFY_EMAIL_RATE_LIMIT_MAX ??= "1000000";
process.env.RESEND_VERIFICATION_RATE_LIMIT_MAX ??= "1000000";
process.env.STORAGE_ROOT ??= mkdtempSync(join(tmpdir(), "pm-test-storage-"));
process.env.SESSION_SECRET ??= "test-session-secret-0123456789-abcdefgh";
process.env.TOKEN_HASH_SECRET ??= "test-token-hash-secret-0123456789-abcdef";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.NODE_ENV = "test";
