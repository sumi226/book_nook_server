import type { Request, Response } from "express";
import { createApp } from "../src/app.js";
import { connectDatabase } from "../src/database.js";

const app = createApp();

export default async function handler(request: Request, response: Response) {
  await connectDatabase();

  if (request.url?.startsWith("/api/")) {
    request.url = request.url.slice(4);
  } else if (request.url === "/api") {
    request.url = "/";
  }

  app(request, response);
}
