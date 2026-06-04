import "dotenv/config";
import express from "express";
import { router } from "./routes/index.js";

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "ledgerpro-server" }));
app.use("/api", router);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`LedgerPro server listening on :${port}`);
});
