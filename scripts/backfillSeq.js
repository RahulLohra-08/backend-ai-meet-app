import mongoose from 'mongoose';
import 'dotenv/config';
import Transcript from '../src/models/Transcript.js';
import Meeting from '../src/models/Meeting.js';

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false }); // don't build the broken index yet

const meetingIds = await Transcript.distinct('meeting', { seq: { $exists: false } });
for (const meetingId of meetingIds) {
  const docs = await Transcript.find({ meeting: meetingId }).sort({ occurredAt: 1, createdAt: 1, _id: 1 }).select('_id');
  await Transcript.bulkWrite(docs.map((d, i) => ({
    updateOne: { filter: { _id: d._id }, update: { $set: { seq: i + 1 } } }
  })));
  // keep the atomic counter in sync so new segments continue after the last one
  await Meeting.updateOne({ _id: meetingId }, { $set: { transcriptSeq: docs.length } });
  console.log(`meeting ${meetingId}: ${docs.length} segments renumbered`);
}
await mongoose.disconnect();