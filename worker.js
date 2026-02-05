export async function onRequest({ params, env }) {
  const res = await fetch(
    `https://api.craftersmc.net/v1/skyblock/bazaar/${params.itemId}/details`,
    {
      headers: {
        'X-API-Key': "ccb8f8cd-6d3e-40c5-8a77-c9a928d3aa94"
      }
    }
  )

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30'
    }
  })
}
