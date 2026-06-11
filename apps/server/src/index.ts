import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();
app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then((addr) => app.log.info(`Pageden API listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
