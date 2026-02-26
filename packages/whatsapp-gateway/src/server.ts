import express from "express";
import { sendRouter } from "./routes/send.js";
import { healthRouter } from "./routes/health.js";
import { env } from "./lib/env.js";

export const app: express.Express = express();
app.use(express.json({ limit: "100kb" }));

app.use("/health", healthRouter);
app.use("/send", sendRouter);

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.js");

if (isMain) {
  app.listen(env.PORT, () => {
    console.log(`WhatsApp Gateway listening on port ${env.PORT}`);
  });
}
