import mongoose from 'mongoose';

const participantSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['host', 'participant'], default: 'participant' },
  joinedAt: Date,        // first join
  lastJoinedAt: Date,    // most recent (re)join
  leftAt: Date,          // cleared on rejoin
  captionLanguage: { type: String, default: 'en' }
}, { _id: false });

const meetingSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  code: { type: String, required: true, unique: true },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [participantSchema],
  status: { type: String, enum: ['scheduled', 'live', 'completed'], default: 'scheduled' },
  // 'auto' = let the speech provider detect the language of each segment.
  sourceLanguage: { type: String, default: 'auto' },
  targetLanguage: { type: String, default: 'en' },
  supportedLanguages: { type: [String], default: [] },
  // Access control: when requireInvite is true only invited e-mail addresses (or the host) may join.
  requireInvite: { type: Boolean, default: false },
  invitedEmails: { type: [String], default: [] },
  // Monotonic per-meeting segment counter -> total ordering of transcript segments.
  transcriptSeq: { type: Number, default: 0 },
  retentionDays: { type: Number, default: null },
  notes: { type: mongoose.Schema.Types.Mixed, default: null }, // legacy field from the first backend iteration
  startedAt: Date,
  endedAt: Date
}, { timestamps: true });

meetingSchema.index({ host: 1, updatedAt: -1 });
meetingSchema.index({ 'participants.user': 1, updatedAt: -1 });
meetingSchema.index({ status: 1, endedAt: 1 });

export default mongoose.model('Meeting', meetingSchema);
