import type { Express } from "express";
import express from "express";
import { resolve } from "node:path";

export function mountStaticClientPortal(app: Express): void {
  const publicPath = resolve("src/web/static");
  const clientPath = resolve("dist/web/client");
  const protocolPath = resolve("dist/protocol");
  const pretextPath = resolve("node_modules/@chenglou/pretext/dist");

  app.use(express.static(publicPath, { extensions: ["html"] }));
  app.use("/client", express.static(clientPath));
  app.use("/protocol", express.static(protocolPath));
  app.use("/vendor/pretext", express.static(pretextPath));

  app.get("/", (_request, response) => {
    response.sendFile(resolve(publicPath, "index.html"));
  });
}
