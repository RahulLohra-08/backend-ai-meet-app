// Usage:  npm run indexes:check            (report only, changes nothing)
//         npm run indexes:fix              (drops stale UNIQUE indexes: ones the current schemas do not declare)
//         node scripts/check-indexes.js --apply --all   (drops every stale index)
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import '../src/models/User.js'; import '../src/models/RefreshToken.js'; import '../src/models/Meeting.js'; import '../src/models/Transcript.js';
import '../src/models/Translation.js'; import '../src/models/Summary.js'; import '../src/models/ActionItem.js';
import { auditIndexes } from '../src/services/indexAudit.js';

const apply = process.argv.includes('--apply');
const dropAll = process.argv.includes('--all');
await connectDatabase();
const findings = await auditIndexes({ apply, dropAll });
if (!findings.length) console.log('OK: no stale indexes. Every index in MongoDB is declared by the current schemas.');
for (const f of findings) {
  console.log(`${f.dropped ? 'DROPPED' : f.unique ? 'STALE UNIQUE (blocks inserts)' : 'stale (harmless)'}  ${f.collection}.${f.name}  key=${JSON.stringify(f.key)}`);
}
if (findings.some(f => f.unique && !f.dropped)) console.log('\nRe-run with --apply (npm run indexes:fix) to drop the stale UNIQUE indexes listed above.');
await mongoose.disconnect();
