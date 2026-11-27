import { Effect } from "effect";
import { readConfig } from "./config.ts";
import type { OwnerIdentity } from "./identity.ts";

export const syntheticOwner: OwnerIdentity<"OWNER_EMAIL"> = {
  readConfig: (env) => readConfig(env, ["OWNER_EMAIL"]),
  authenticate: (_headers, config) => Effect.succeed(config.OWNER_EMAIL),
};
