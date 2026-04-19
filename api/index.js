import { connectDB } from '../server/db.js';
import app from '../server/index.js';

let dbConnected = false;

export default async function handler(req, res) {
  if (!dbConnected) {
    await connectDB();
    dbConnected = true;
  }
  return app(req, res);
}
