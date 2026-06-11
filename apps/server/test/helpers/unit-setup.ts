// Minimal env for unit tests that import modules which read `env` at load time (e.g. google.ts).
// Unit tests never touch the database; DATABASE_URL just needs to be a valid-looking string.
process.env.DATABASE_URL ??= "postgresql://localhost:5432/unit_test";
process.env.SESSION_SECRET ??= "unit-session-secret-0123456789-abcdefgh";
process.env.TOKEN_HASH_SECRET ??= "unit-token-hash-secret-0123456789-abcd";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.STORAGE_ROOT ??= "/tmp";
