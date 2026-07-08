import type { VercelRequest, VercelResponse } from "@vercel/node";
import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "../../src/auth.js";
import { toWebRequest, sendWebResponse } from "../../src/utils/vercel-web.js";

// Served at the root well-known path via a rewrite in vercel.json so MCP
// clients (the Claude app) discover the authorization server.
const metadata = oAuthDiscoveryMetadata(auth);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const response = await metadata(toWebRequest(req));
  await sendWebResponse(res, response);
}
