import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  preferredLanguage: { type: String, default: 'en', maxlength: 10 },
  // Bumped on password change / logout-all: invalidates every outstanding access token.
  tokenVersion: { type: Number, default: 0 },
  passwordChangedAt: Date,
  resetTokenHash: { type: String, select: false },
  resetTokenExpires: { type: Date, select: false }
}, { timestamps: true });

export default mongoose.model('User', userSchema);
