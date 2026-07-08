import type { VercelRequest, VercelResponse } from "@vercel/node";
import { auth } from "../../src/auth.js";
import { toWebRequest, sendWebResponse } from "../../src/utils/vercel-web.js";

/**
 * Catch-all for every Better Auth endpoint under /api/auth/*:
 *   /api/auth/sign-in/social         (GitHub sign-in kick-off)
 *   /api/auth/callback/github        (GitHub OAuth callback)
 *   /api/auth/mcp/authorize|token|register
 *   /api/auth/oauth2/consent
 *   /api/auth/.well-known/*
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const response = await auth.handler(toWebRequest(req));
  await sendWebResponse(res, response);
}
