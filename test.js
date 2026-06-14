exports.handler = async (event) => {
  const hasClientId = !!process.env.PODIO_CLIENT_ID;
  const hasClientSecret = !!process.env.PODIO_CLIENT_SECRET;
  
  // Try to get a Podio token
  let tokenResult = "not tested";
  try {
    const res = await fetch("https://podio.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.PODIO_CLIENT_ID,
        client_secret: process.env.PODIO_CLIENT_SECRET,
      }),
    });
    const data = await res.json();
    tokenResult = data.access_token ? "SUCCESS - got token" : "FAILED - " + JSON.stringify(data);
  } catch (err) {
    tokenResult = "ERROR - " + err.message;
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hasClientId,
      hasClientSecret,
      tokenResult,
    }, null, 2),
  };
};
