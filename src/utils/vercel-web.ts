import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Better Auth speaks the Web Fetch `Request`/`Response` API, but Vercel Node
 * functions hand us `(req, res)` and eagerly parse the body into `req.body`.
 * These helpers bridge the two: reconstruct a `Request` (re-encoding the parsed
 * body so Better Auth can read it) and stream a `Response` back out.
 */

export function toWebRequest(req: VercelRequest): Request {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const url = `${proto}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // content-length is stale once we re-encode the parsed body below.
    if (key.toLowerCase() === "content-length") continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  let body: string | Buffer | undefined;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && req.body != null) {
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (typeof req.body === "string") {
      body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(
        req.body as Record<string, string>
      ).toString();
    } else {
      body = JSON.stringify(req.body);
    }
  }

  return new Request(url, { method, headers, body });
}

export async function sendWebResponse(
  res: VercelResponse,
  response: Response
): Promise<void> {
  res.status(response.status);

  // Set-Cookie must be emitted as separate headers; Headers.forEach collapses
  // them into one comma-joined value, which corrupts cookies.
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

/** Build a Web `Headers` object from a Vercel request (for getMcpSession). */
export function toWebHeaders(req: VercelRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}
