import mongoose from "mongoose";
import { config } from "./config.js";
import { Book, Borrow } from "./models.js";

export async function connectDatabase() {
  await mongoose.connect(config.MONGODB_URI, {
    dbName: config.MONGODB_DB,
    autoIndex: config.NODE_ENV !== "production",
  });
  await Promise.all([Book.init(), Borrow.init()]);
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
