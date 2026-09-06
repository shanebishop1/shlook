import { api } from "../http.ts";
import type { CliDependencies } from "../types.ts";

export async function authCheck(dependencies: CliDependencies): Promise<unknown> {
  return api(dependencies, "/health");
}
