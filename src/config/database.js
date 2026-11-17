import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export async function connectDatabase(uri = env.MONGODB_URI) {
  // Only override DNS when explicitly configured (some networks cannot resolve Atlas SRV records).
  if (env.DNS_SERVERS) dns.setServers(env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info('MongoDB connected');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
