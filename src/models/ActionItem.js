import mongoose from 'mongoose';

const actionSchema = new mongoose.Schema({
  meeting: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assigneeHint: { type: String, default: '', maxlength: 200 }, // name the AI heard but could not match to a participant
  dueDate: { type: Date, default: null },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  status: { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  // ai_suggested -> untouched AI output; user_confirmed -> a person accepted/edited it; manual -> created by a person.
  source: { type: String, enum: ['ai_suggested', 'user_confirmed', 'manual'], default: 'manual' },
  transcriptSeqs: { type: [Number], default: [] }, // transcript segments supporting this item
  completedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

actionSchema.index({ meeting: 1, createdAt: -1 });
actionSchema.index({ assignedTo: 1, status: 1 });

export default mongoose.model('ActionItem', actionSchema);
