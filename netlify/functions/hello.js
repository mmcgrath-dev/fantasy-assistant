// A Netlify Function is just a JavaScript file that runs on a server.
// When someone visits its URL, Netlify runs this function and sends back whatever it returns.

export default async () => {
  // The data we want to send back
  const data = {
    message: "Hello from your Netlify Function",
    time: new Date().toLocaleTimeString(),
  };

  // Send it back as JSON, the standard format APIs use to pass data around
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
};
