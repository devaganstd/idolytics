import { checkAdmin, createProject, dashboard } from "./dashboard";
import { CORS, ingest } from "./ingest";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (pathname === "/v1/events") {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (method === "POST") return ingest(request, env);
      return new Response("Method Not Allowed", { status: 405, headers: CORS });
    }
    if (pathname === "/" && method === "GET") return (await checkAdmin(request, env)) ?? dashboard(request, env);
    if (pathname === "/projects" && method === "POST") return (await checkAdmin(request, env)) ?? createProject(request, env);
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
