import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { Pool } from "pg";

/**
 * Better Auth instance that turns this deployment into an OAuth 2.1 provider
 * for MCP clients (the Claude app connects here via OAuth, not a static token).
 *
 * The iCloud credentials never flow through this layer — they stay in
 * ICLOUD_EMAIL / ICLOUD_APP_PASSWORD on the server. OAuth here only proves the
 * caller is *you* (via GitHub sign-in) before `api/mcp.ts` will serve tools.
 *
 * Required env:
 *   BETTER_AUTH_URL       – full deployment origin, e.g. https://icloud-mcp.vercel.app
 *   BETTER_AUTH_SECRET    – 32+ random bytes (openssl rand -hex 32)
 *   DATABASE_URL          – Neon Postgres connection string (pooled)
 *   GITHUB_CLIENT_ID      – GitHub OAuth app client id
 *   GITHUB_CLIENT_SECRET  – GitHub OAuth app client secret
 *   ALLOWED_EMAILS        – comma-separated allowlist; only these GitHub emails
 *                           may create an account (this is the single-user gate)
 */

const baseURL = process.env.BETTER_AUTH_URL;

const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Single-user gate: refuse to create an account for anyone whose GitHub
        // email isn't in ALLOWED_EMAILS. Once your user row exists, subsequent
        // logins don't hit this hook. If the allowlist is empty we fail closed.
        before: async (user) => {
          const email = user.email.toLowerCase();
          if (allowedEmails.length === 0 || !allowedEmails.includes(email)) {
            throw new APIError("FORBIDDEN", {
              message: "This account is not permitted to use this server.",
            });
          }
        },
      },
    },
  },
  plugins: [
    mcp({
      loginPage: "/sign-in",
      // Advertise the MCP endpoint as the OAuth "protected resource".
      ...(baseURL ? { resource: `${baseURL}/api/mcp` } : {}),
      oidcConfig: {
        loginPage: "/sign-in",
        // Dynamically-registered MCP clients aren't trusted, so Better Auth
        // requires a consent step. This static page one-click-approves it.
        consentPage: "/consent",
      },
    }),
  ],
});
