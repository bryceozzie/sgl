export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    return new Response(`Hello from Cloudflare Workers! You requested ${url.pathname}`, {
      headers: { "content-type": "text/plain" },
    });
  },
} satisfies ExportedHandler<Env>;
