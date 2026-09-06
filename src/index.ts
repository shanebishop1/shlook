import { cleanupExpired } from "./worker/cleanup";
import { type Env } from "./worker/environment";
import { handleRequest } from "./worker/router";

export type { Env } from "./worker/environment";
export { cleanupExpired } from "./worker/cleanup";
export { handleRequest } from "./worker/router";

export default {
  fetch: handleRequest,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Env>;
