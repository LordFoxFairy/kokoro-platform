import { createServer, type Server } from "node:http";

export function createHubConnectHealthServer(
  input: Readonly<{
    ready: () => Promise<boolean>;
    isDraining: () => boolean;
  }>,
): Server {
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health/live") {
      response.statusCode = 200;
      response.end('{"status":"live"}');
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      if (input.isDraining()) {
        response.statusCode = 503;
        response.end('{"status":"not_ready"}');
        return;
      }
      void input.ready().then(
        (ready) => {
          if (response.destroyed) return;
          response.statusCode = ready ? 200 : 503;
          response.end(ready ? '{"status":"ready"}' : '{"status":"not_ready"}');
        },
        () => {
          if (response.destroyed) return;
          response.statusCode = 503;
          response.end('{"status":"dependency_unavailable"}');
        },
      );
      return;
    }
    response.statusCode = 404;
    response.end('{"status":"not_found"}');
  });
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 16;
  return server;
}
