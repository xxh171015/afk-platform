import type { InvalidatePayload } from "@afk/shared";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";

export const SSE_KEEPALIVE_MS = 15_000;

function encodeInvalidate(payload: InvalidatePayload): string {
  return `event: invalidate\ndata: ${JSON.stringify(payload)}\n\n`;
}

// GET /events is not in the OpenAPI document: browsers open it as EventSource, not as a JSON client.

export function registerEventRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  app.get("/events", (c) => {
    const encoder = new TextEncoder();
    let unsubscribe = (): void => {};
    let ping: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // the client went away
          }
        };
        unsubscribe = context.events.subscribe((payload) => {
          send(encodeInvalidate(payload));
        });
        ping = setInterval(
          () => send(": keepalive\n\n"),
          context.sseKeepaliveMs,
        );
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          if (ping !== undefined) clearInterval(ping);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        unsubscribe();
        if (ping !== undefined) clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
