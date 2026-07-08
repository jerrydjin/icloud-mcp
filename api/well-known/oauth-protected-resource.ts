import type { VercelRequest, VercelResponse } from "@vercel/node";
import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "../../src/auth.js";
import { toWebRequest, sendWebResponse } from "../../src/utils/vercel-web.js";

// Served at the root well-known path via a rewrite in vercel.json. The 401 from
// /api/mcp points here (WWW-Authenticate: resource_metadata=...).
const metadata = oAuthProtectedResourceMetadata(auth);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const response = await metadata(toWebRequest(req));
  await sendWebResponse(res, response);
}
