import { createApp } from "./app.ts";
import { connectDatabase } from "./database.ts";

const app = createApp();
let databaseConnection;

export default async function handler(request, response) {
  if (!databaseConnection) {
    databaseConnection = connectDatabase().catch((error) => {
      databaseConnection = undefined;
      throw error;
    });
  }

  await databaseConnection;
  return app(request, response);
}
