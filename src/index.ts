import { Effect } from "effect";

export interface RuntimeIdentity {
  readonly name: string;
}

export const runtimeIdentity: Effect.Effect<RuntimeIdentity> = Effect.succeed({
  name: "os",
});

export const readRuntimeIdentity = (): RuntimeIdentity => Effect.runSync(runtimeIdentity);
