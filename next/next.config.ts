import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { stripZcodeHostProviderEnv } from "./src/lib/agents/zcode-model-binding";

const nextConfig: NextConfig = {
  /* config options here */
};

export default (phase: string): NextConfig => {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    // Strip the provider-config env vars the ZCode desktop host injects
    // into every terminal it spawns, so a dev run matches a clean machine
    // (rationale in stripZcodeHostProviderEnv). Log what was removed.
    const stripped = stripZcodeHostProviderEnv(process.env);
    if (stripped.length > 0) {
      console.info(
        `[next.config] stripped ZCode host-injected provider env vars: ${stripped.join(", ")}`,
      );
    }
  }
  return nextConfig;
};
