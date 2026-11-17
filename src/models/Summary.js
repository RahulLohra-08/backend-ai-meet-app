import mongoose from 'mongoose';

const summarySchema = new mongoose.Schema({
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true, unique: true },
  status: { type: String, enum: ['processing', 'completed', 'failed'], required: true },
  content: {
    overview: { type: String, default: '' },
    executiveSummary: { type: String, default: '' },
    discussionTopics: { type: [String], default: [] },
    keyPoints: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    unresolvedQuestions: { type: [String], default: [] },
    nextSteps: { type: [String], default: [] }
  },
  error: { type: String, default: '' },
  errorCode: { type: String, default: '' },
  retryable: { type: Boolean, default: true }, // false => retrying cannot help (e.g. quota exhausted, key invalid)
  provider: { type: String, default: '' },
  model: { type: String, default: '' },
  outputLanguage: { type: String, default: 'en' },
  attempts: { type: Number, default: 0 },
  transcriptCount: { type: Number, default: 0 },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startedAt: Date,
  completedAt: Date
}, { timestamps: true });

export default mongoose.model('Summary', summarySchema);
