import { createApp } from "./app.js";
import { readNodeRuntimeConfig } from "./node/node.config.js";

const config = readNodeRuntimeConfig();
const app = createApp();

app.listen(config.bindPort, config.bindHost, () => {
  console.log(`sudo listening on http://${config.bindHost}:${config.bindPort}`);
});
