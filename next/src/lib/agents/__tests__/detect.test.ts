import { describe, expect, it } from "vitest";
import {
  AGENTS,
  DEFAULT_MODEL,
  detectAgents,
  type AgentDef,
  type AgentProtocol,
} from "../detect";

describe("AgentProtocol type surface (T2)", () => {
  it("accepts \"app-server\" as a union member", () => {
    // Compile-time proof: if "app-server" is missing from the union this
    // assignment fails typecheck. The runtime echo keeps the test meaningful.
    const p: AgentProtocol = "app-server";
    expect(p).toBe("app-server");
  });

  it("AgentDef accepts optional binArgs?: string[]", () => {
    const withBinArgs: AgentDef = {
      id: "type-probe",
      label: "Type Probe",
      bin: "type-probe",
      vendor: "probe",
      protocol: "app-server",
      binArgs: ["<resolved-cjs-path>", "app-server"],
      fallbackModels: [DEFAULT_MODEL],
    };
    expect(withBinArgs.binArgs).toEqual(["<resolved-cjs-path>", "app-server"]);
  });

  it("AgentDef.binArgs is optional (existing entries omit it)", () => {
    // Check the whole array, not a sample, so a future entry that accidentally
    // sets a required-looking binArgs is caught here.
    for (const def of AGENTS) {
      expect(def.binArgs).toBeUndefined();
    }
  });

  it("detectAgents still surfaces the existing protocol set", () => {
    // Regression guard: the new "app-server" union member must not flip the
    // unsupported flag for any of the protocols already in use.
    const agents = detectAgents();
    const protocols = new Set(agents.map((a) => a.protocol));
    for (const expected of [
      "stdin",
      "argv",
      "argv-message",
      "acp",
      "pi-rpc",
    ] as const) {
      expect(protocols.has(expected)).toBe(true);
    }
  });
});
