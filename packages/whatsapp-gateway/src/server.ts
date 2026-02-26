import express from "express";
import { sendRouter } from "./routes/send.js";
import { healthRouter } from "./routes/health.js";
import { env } from "./lib/env.js";
import { isMainModule } from "@trading/shared";

export const app: express.Express = express();
app.use(express.json({ limit: "100kb" }));

app.use("/health", healthRouter);
app.use("/send", sendRouter);

if (isMainModule(import.meta.url)) {
  app.listen(env.PORT, () => {
    console.log(`WhatsApp Gateway listening on port ${env.PORT}`);
  });
}
