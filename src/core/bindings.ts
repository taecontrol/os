import { Context } from "effect";

export class Bindings extends Context.Service<Bindings, Env>()("os/core/Bindings") {}

export class Execution extends Context.Service<Execution, ExecutionContext>()(
  "os/core/Execution",
) {}
