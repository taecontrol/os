import { makeAccessIdentity } from "./access.ts";
import { makeCore } from "./core.ts";
import { syntheticOwner } from "./synthetic-owner.ts";

const core = SYNTHETIC_OWNER ? makeCore(syntheticOwner) : makeCore(makeAccessIdentity());

export default {
  fetch: (request, env) => core(request, env),
} satisfies ExportedHandler<Env>;
