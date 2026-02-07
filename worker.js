export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // =====================
    // /api/ai?q=QUESTION
    // =====================
    if (pathname === "/api/ai") {
      const question = url.searchParams.get("q");

      if (!question) {
        return new Response(
          JSON.stringify({ error: "Missing q" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // ---- SAFELY get API key from KV ----
      if (!env.FILES) {
        return new Response(
          JSON.stringify({ error: "FILES binding missing" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      let apiKey;
      try {
        apiKey = await env.FILES.get("CMC");
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to read FILES KV" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "CMC key not found in FILES" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      // ---- OpenRouter fetch ----
      const res = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "CraftersMC Navigators",
            "X-Title": "CraftersMC Navigators"
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b:free",
            messages: [
              { role: "user", content: question }
            ],
            reasoning: { enabled: true }
          })
        }
      );

      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store"
        }
      });
    }

    // =====================
    // EXISTING BAZAAR LOGIC
    // =====================
    const itemId = url.searchParams.get("itemId");
    const apiKey = url.searchParams.get("api");

    if (!itemId) {
      return new Response(
        JSON.stringify({ error: "Missing itemId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing API key in query (?api=)" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const res = await fetch(
      `https://api.craftersmc.net/v1/skyblock/bazaar/${itemId}/details`,
      {
        headers: {
          "X-API-Key": apiKey
        }
      }
    );

    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30"
      }
    });
  }
};
