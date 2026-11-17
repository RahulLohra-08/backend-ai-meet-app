import Meeting from '../../models/Meeting.js';
import Transcript from '../../models/Transcript.js';
import Translation from '../../models/Translation.js';
import Summary from '../../models/Summary.js';
import ActionItem from '../../models/ActionItem.js';

/** Permanently delete a meeting and everything derived from it. */
export async function deleteMeetingCascade(meetingId) {
  await Promise.all([
    Transcript.deleteMany({ meeting: meetingId }),
    Translation.deleteMany({ meeting: meetingId }),
    Summary.deleteMany({ meeting: meetingId }),
    ActionItem.deleteMany({ meeting: meetingId })
  ]);
  await Meeting.deleteOne({ _id: meetingId });
}
