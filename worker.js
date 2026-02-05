export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Get API key from query params
    const apiKey = url.searchParams.get("key");
    if (!apiKey) {
      return new Response("Missing API key", { status: 400 });
    }

    // Get values from query params (supports multiple)
    const values = url.searchParams.getAll("values");
    if (values.length === 0) {
      return new Response("Missing values", { status: 400 });
    }

    // Build request body
    const body = JSON.stringify({
      values: values,
    });

    // Forward request
    const response = await fetch(
      "https://api.craftersmc.net/v1/skyblock/bazaar/items",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        body,
      }
    );

    // Return API response directly
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  },
};
