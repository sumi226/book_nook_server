import { config } from "./config.js";
import { createApp } from "./app.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./database.js";

async function start() {
  await connectDatabase();

  const server = createApp().listen(config.PORT, () => {
    console.log(`BookNook API listening on port ${config.PORT}`);
  });

  const shutdown = async () => {
    server.close(async (error) => {
      if (error) {
        console.error("Failed to close the HTTP server", error);
        process.exitCode = 1;
      }
      await disconnectDatabase();
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch((error: unknown) => {
  console.error("Failed to start BookNook API", error);
  process.exitCode = 1;
});
