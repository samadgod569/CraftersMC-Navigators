export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const itemId = url.searchParams.get("itemId");
    if (!itemId) {
      return new Response(
        JSON.stringify({ error: "Missing itemId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const apiKey = "ccb8f8cd-6d3e-40c5-8a77-c9a928d3aa94";

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing API key in env" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const res = await fetch(
      `https://api.craftersmc.net/v1/skyblock/bazaar/${itemId}/details`,
      {
        headers: {
          "X-API-Key": apiKey,
        },
      }
    );

    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30",
      },
    });
  },
};
