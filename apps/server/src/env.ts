// Centralized, validated environment access. Fails fast on missing required vars.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function requiredSecret(name: string, minLength = 32): string {
  const v = required(name);
  if (v.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters.`);
  }
  if (v === "replace-in-development" && process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be changed in production.`);
  }
  return v;
}

function normalizeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`Expected a valid URL origin, got: ${raw}`);
  }
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: requiredSecret("SESSION_SECRET"),
  tokenHashSecret: requiredSecret("TOKEN_HASH_SECRET"),
  storageRoot: process.env.STORAGE_ROOT ?? "./storage",
  // Object storage backend: "fs" (default; local filesystem) or "spaces" (S3-compatible).
  storageDriver: (process.env.STORAGE_DRIVER ?? "fs").toLowerCase(),
  // DigitalOcean Spaces / S3 (used only when STORAGE_DRIVER=spaces).
  spacesBucket: process.env.SPACES_BUCKET,
  spacesRegion: process.env.SPACES_REGION ?? "us-east-1",
  spacesEndpoint: process.env.SPACES_ENDPOINT,
  spacesForcePathStyle: booleanEnv("SPACES_FORCE_PATH_STYLE", false),
  spacesAccessKeyId: process.env.SPACES_ACCESS_KEY_ID,
  spacesSecretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY,
  appUrl: normalizeOrigin(process.env.APP_URL ?? process.env.WEB_ORIGIN ?? "http://localhost:3000"),
  cloudHosted: booleanEnv("CLOUD_HOSTED", false),
  baseDomain: process.env.BASE_DOMAIN?.trim().toLowerCase(),
  webOrigin: normalizeOrigin(process.env.WEB_ORIGIN ?? "http://localhost:3000"),
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  // Google OAuth (optional). When unset, the Google sign-in routes report not-configured.
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // Where Google redirects back to (must match the Google Cloud console). Defaults to the API origin.
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ?? `${normalizeOrigin(process.env.APP_URL ?? process.env.WEB_ORIGIN ?? "http://localhost:4000")}/api/auth/google/callback`,
};

export const googleConfigured = Boolean(env.googleClientId && env.googleClientSecret);

if (!["fs", "spaces"].includes(env.storageDriver)) {
  throw new Error(`STORAGE_DRIVER must be "fs" or "spaces", got: ${env.storageDriver}`);
}
if (env.storageDriver === "spaces" && (!env.spacesBucket || !env.spacesAccessKeyId || !env.spacesSecretAccessKey)) {
  throw new Error("STORAGE_DRIVER=spaces requires SPACES_BUCKET, SPACES_ACCESS_KEY_ID, and SPACES_SECRET_ACCESS_KEY.");
}

if (env.cloudHosted && !env.baseDomain) {
  throw new Error("BASE_DOMAIN is required when CLOUD_HOSTED=true.");
}
