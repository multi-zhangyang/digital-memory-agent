export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Forward streams without Next rewrite's request cloning / 10 MB buffer limit.
async function forward(request: Request) {
  const source = new URL(request.url);
  const origin = process.env.AGENT_ORIGIN || "http://127.0.0.1:4310";
  const target = new URL(source.pathname + source.search, origin);
  const headers = new Headers({ "accept-encoding": "identity" });
  for (const name of [
    "host",
    "content-type",
    "range",
    "origin",
    "sec-fetch-site",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const options = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half" as const,
      signal: request.signal,
      cache: "no-store" as const,
      redirect: "manual" as const,
    };
    const upstream = await fetch(target, options);
    const responseHeaders = new Headers(upstream.headers);
    for (const name of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "content-encoding",
    ])
      responseHeaders.delete(name);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "AGENT_UNAVAILABLE",
          message: "本地 Agent 服务未连接，请检查服务是否已启动。",
        },
      },
      { status: 503 },
    );
  }
}

export {
  forward as GET,
  forward as POST,
  forward as PUT,
  forward as HEAD,
  forward as PATCH,
  forward as DELETE,
};
