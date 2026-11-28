import { Schema } from "effect";

export const grantModes = ["allow", "ask", "deny"] as const;
export const GrantMode = Schema.Literals(grantModes);
export type GrantMode = typeof GrantMode.Type;
export const Grants = Schema.Array(Schema.Struct({ capability: Schema.String, mode: GrantMode }));

export const notificationsSend = {
  id: "notifications.send",
  title: "Send you notifications",
  description: "Push a notification to your phone.",
  scope: "installation",
} as const;

export const capabilityCatalog = [notificationsSend] as const;
export type Capability = (typeof capabilityCatalog)[number];

export const findCapability = (id: string) =>
  capabilityCatalog.find((capability) => capability.id === id);
