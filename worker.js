export async function onRequest({ params, env }) {
  const res = await fetch(
    `https://api.craftersmc.net/v1/skyblock/bazaar/${params.itemId}/details`,
    {
      headers: {
        'X-API-Key': env.CMC_API_KEY || env.cmc_api_key || env['cmc-api-key']
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
