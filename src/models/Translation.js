import mongoose from 'mongoose';

const translationSchema = new mongoose.Schema({
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true, index: true },
  transcript: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', required: true },
  sourceLanguage: { type: String, default: 'auto' },
  targetLanguage: { type: String, required: true },
  text: { type: String, required: true, maxlength: 20000 },
  provider: { type: String, required: true }
}, { timestamps: true });

translationSchema.index({ transcript: 1, targetLanguage: 1 }, { unique: true });

export default mongoose.model('Translation', translationSchema);
