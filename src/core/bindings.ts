import { Context } from "effect";

export class Bindings extends Context.Service<Bindings, Env>()("os/core/Bindings") {}
