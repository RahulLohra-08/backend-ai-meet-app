import mongoose from 'mongoose';

// One finalized speech segment. Translations live in their own collection and never overwrite `text`.
const transcriptSchema = new mongoose.Schema({
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  seq: { type: Number, required: true },
  speaker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  speakerName: { type: String, required: true },
  text: { type: String, required: true, maxlength: 12000 },
  sourceLanguage: { type: String, default: 'auto' },   // what the speaker selected
  detectedLanguage: { type: String, default: null },   // what the provider detected (if it can)
  provider: { type: String, default: 'browser' },       // browser | openai | ...
  clientSegmentId: { type: String, required: true, maxlength: 150 },
  audioDurationMs: { type: Number, default: null },
  occurredAt: { type: Date, default: Date.now }
}, { timestamps: true });

transcriptSchema.index({ meeting: 1, seq: 1 }, { unique: true });
// Idempotency: the same client segment can never be stored twice for one speaker.
transcriptSchema.index({ meeting: 1, speaker: 1, clientSegmentId: 1 }, { unique: true, partialFilterExpression: { clientSegmentId: { $type: 'string', $gt: '' } } });

export default mongoose.model('Transcript', transcriptSchema);
