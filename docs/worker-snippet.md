```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;

    const key = `cfg:${host}`;
    const cfgJson = await env.TENANTS.get(key);

    if (!cfgJson) {
      return new Response("No configuration for host", { status: 404 });
    }

    const cfg = JSON.parse(cfgJson);

    // Simple longest-prefix route match
    const pathname = url.pathname;
    let matchedRoute = null;
    for (const route of cfg.routes ?? []) {
      if (pathname.startsWith(route.pathPrefix)) {
        if (!matchedRoute || route.pathPrefix.length > matchedRoute.pathPrefix.length) {
          matchedRoute = route;
        }
      }
    }

    if (!matchedRoute) {
      return new Response("No matching route", { status: 404 });
    }

    if (matchedRoute.mode === "blocked") {
      return new Response("Blocked", { status: 403 });
    }

    if (matchedRoute.mode === "paid") {
      // TODO: Implement x402 verification
      const hasPayment = request.headers.get("x-402-payment") ?? null;
      if (!hasPayment) {
        return new Response("Payment required", {
          status: 402,
          headers: {
            "x-402-reason": "missing payment",
          },
        });
      }
    }

    // Proxy to origin
    const originUrl = new URL(cfg.origin.url);
    const target = new URL(request.url);
    target.protocol = originUrl.protocol;
    target.host = originUrl.host;

    const headers = new Headers(request.headers);
    if (cfg.origin.hostOverride) {
      headers.set("host", cfg.origin.hostOverride);
    }

    return fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
    });
  },
};
```














