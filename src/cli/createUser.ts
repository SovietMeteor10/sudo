import { createDevIdentity } from "../identity/devSignup.js";
import { readNodeRuntimeConfig, resolveIdentityHost } from "../node/node.config.js";

const rawHandle = process.argv[2];

if (!rawHandle) {
  console.error("usage: npm run create-user -- SovietMeteor");
  process.exit(1);
}

const config = readNodeRuntimeConfig();
const host = resolveIdentityHost(config);
const baseUrl = process.env.SUDO_BASE_URL?.trim() || config.publicBaseUrl;
const password = process.env.SUDO_DEV_PASSWORD ?? "DevPassword123!";
const recoveryQuestion = process.env.SUDO_DEV_RECOVERY_QUESTION ?? "private sentence you can remember";
const recoveryAnswer = process.env.SUDO_DEV_RECOVERY_ANSWER ?? `dev recovery ${rawHandle}`;
const result = createDevIdentity({ rawHandle, password, recoveryQuestion, recoveryAnswer, baseUrl, host });
const identityDocument = result.identity;

console.log(`created ${identityDocument.handle}`);
console.log(`canonical: ${identityDocument.canonical_id}`);
console.log(`profile:   ${identityDocument.profile}`);
console.log(`finger:    ${identityDocument.finger}`);
console.log(`inbox:     ${identityDocument.inbox}`);
console.log(`fingerprint: ${identityDocument.visual_fingerprint?.fingerprint}`);
console.log("");
console.log("note: private keys are no longer persisted server-side; feed posts must arrive client-signed");
console.log("dev backup code: shown once, store it somewhere local");
console.log(result.backupCode);
