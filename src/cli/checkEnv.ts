import { readNodeRuntimeConfig, resolveIdentityHost } from "../node/node.config.js";

const config = readNodeRuntimeConfig();
const identityHost = resolveIdentityHost(config);
const warnings: string[] = [];
const dataDir = config.dataDir;
const dbPath = config.dbPath;

if (!process.env.SUDO_PUBLIC_BASE_URL) {
  warnings.push("SUDO_PUBLIC_BASE_URL is unset. Identity URLs will use a local default.");
}

if (config.publicBaseUrl.includes("example.com")) {
  warnings.push("SUDO_PUBLIC_BASE_URL still points at example.com. Set this to your real public URL.");
}

if (!dbPath.startsWith(dataDir)) {
  warnings.push(`SUDO_DB_PATH (${dbPath}) is outside SUDO_DATA_DIR (${dataDir}). Backups should cover both paths.`);
}

if (process.env.NODE_ENV !== "production" && process.env.SUDO_PUBLIC_BASE_URL?.startsWith("https://")) {
  warnings.push("NODE_ENV is not 'production' but SUDO_PUBLIC_BASE_URL is https. Set NODE_ENV=production for deployments.");
}

if (config.bindHost === "0.0.0.0") {
  warnings.push("Bind host is 0.0.0.0. Bind to 127.0.0.1 and put nginx in front for production.");
}

if (config.requireInvite && config.allowSignups) {
  warnings.push("SUDO_REQUIRE_INVITE is true but SUDO_ALLOW_SIGNUPS is also true. The signup endpoint will reject unauthenticated requests.");
}

const summary = {
  node: {
    name: config.nodeName,
    publicBaseUrl: config.publicBaseUrl,
    onionBaseUrl: config.onionBaseUrl,
    identityHost
  },
  bind: {
    host: config.bindHost,
    port: config.bindPort
  },
  storage: {
    dataDir,
    dbPath
  },
  policy: {
    allowSignups: config.allowSignups,
    requireInvite: config.requireInvite,
    enableHttpsRelayFallback: config.enableHttpsRelayFallback,
    preferOnionRelays: config.preferOnionRelays
  },
  runtime: {
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    isLocalDevelopment: config.isLocalDevelopment,
    logLevel: config.logLevel
  }
};

console.log("sudo resolved config:");
console.log(JSON.stringify(summary, null, 2));

if (warnings.length > 0) {
  console.log("\nwarnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
} else {
  console.log("\nno warnings.");
}
