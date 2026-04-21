import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDB() {
  try {
    const conn = await mongoose.connect(config.mongo.uri);
    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }
}

mongoose.connection.on('disconnected', () => console.warn('[DB] MongoDB disconnected'));
mongoose.connection.on('error', (err) => console.error('[DB] MongoDB error:', err));
