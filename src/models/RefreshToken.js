import mongoose from 'mongoose';

// Opaque refresh tokens: only a SHA-256 hash is stored, tokens rotate on every use,
// and `family` lets us revoke the whole chain if a rotated token is replayed.
const refreshSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  family: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  replacedBy: String, // tokenHash of the successor
  remember: { type: Boolean, default: false },
  userAgent: { type: String, maxlength: 200 }
}, { timestamps: true });
refreshSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB TTL cleanup

export default mongoose.model('RefreshToken', refreshSchema);
