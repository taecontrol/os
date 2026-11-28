import { Effect, Schema } from "effect";
import { Unavailable } from "./refusal.ts";

export const query = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new Unavailable() });

export const decodeStored = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) => decode(value).pipe(Effect.mapError(() => new Unavailable()));
};
