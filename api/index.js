// Vercel serverless entry point. Vercel needs a DEFAULT EXPORT that is a function (req, res) or an Express app.
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';

const app = createApp();

// Reuse the DB connection across warm invocations; connect lazily on the first request.
let dbPromise = null;
function ensureDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!dbPromise) {
    dbPromise = connectDatabase().catch(err => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

export default async function handler(req, res) {
  try {
    await ensureDb();
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    return res.status(500).json({ error: 'Database connection failed' });
  }
  return app(req, res);
}