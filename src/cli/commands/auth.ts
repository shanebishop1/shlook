import { api } from "../http.ts";
import type { CliDependencies } from "../types.ts";

export async function authCheck(dependencies: CliDependencies): Promise<unknown> {
  if (dependencies.backend === "native")
    return {
      ...((await api(dependencies, "/api/me")) as object),
      instance: dependencies.instanceName,
      origin: dependencies.selectedOrigin,
    };
  return api(dependencies, "/health");
}
