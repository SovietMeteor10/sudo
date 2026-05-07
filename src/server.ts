import express from "express";
import { resolve } from "node:path";
import "./db.js";
import { devRouter } from "./routes/dev.js";
import { fingerRouter } from "./routes/finger.js";
import { inboxRouter } from "./routes/inbox.js";
import { profileRouter } from "./routes/profile.js";
import { wellKnownRouter } from "./routes/wellKnown.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const publicPath = resolve("src/public");
const clientPath = resolve("dist/client");
const pretextPath = resolve("node_modules/@chenglou/pretext/dist");

app.use(express.static(publicPath, { extensions: ["html"] }));
app.use("/client", express.static(clientPath));
app.use("/vendor/pretext", express.static(pretextPath));

app.get("/", (_request, response) => {
  response.sendFile(resolve(publicPath, "index.html"));
});

app.use(wellKnownRouter);
app.use(devRouter);
app.use(profileRouter);
app.use(fingerRouter);
app.use(inboxRouter);

app.use((_request, response) => {
  response.status(404).type("text/plain").send("sudo: not found\n");
});

app.listen(port, host, () => {
  console.log(`sudo listening on http://${host}:${port}`);
});
