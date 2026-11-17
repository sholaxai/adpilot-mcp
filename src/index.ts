#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdapterRegistry } from "./adapters/adapter.js";
import { MetaAdapter } from "./adapters/meta.js";
import { MockAdapter } from "./adapters/mock.js";
import { DEFAULT_POLICY, Guardrails } from "./guardrails/policy.js";
import { buildServer } from "./server.js";

const env = process.env;
const registry = new AdapterRegistry();

if (env.META_AD_ACCOUNT_ID && env.META_ACCESS_TOKEN) {
  registry.register(new MetaAdapter(env.META_AD_ACCOUNT_ID, env.META_ACCESS_TOKEN, env.CURRENCY));
}
if (env.ADPILOT_MOCK === "1" || registry.all().length === 0) {
  registry.register(new MockAdapter());
}

const guard = new Guardrails({
  ...DEFAULT_POLICY,
  maxTotalDaily: Number(env.ADPILOT_MAX_TOTAL_DAILY ?? DEFAULT_POLICY.maxTotalDaily),
  maxChangePct: Number(env.ADPILOT_MAX_CHANGE_PCT ?? DEFAULT_POLICY.maxChangePct),
  protectedCampaigns: (env.ADPILOT_PROTECTED ?? "").split(",").filter(Boolean),
  auditLogPath: env.ADPILOT_AUDIT_LOG,
});

await buildServer(registry, guard).connect(new StdioServerTransport());
console.error(`adpilot-mcp ready (${registry.all().map((a) => a.platform).join(", ")})`);
