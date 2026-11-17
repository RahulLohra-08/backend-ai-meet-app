import mongoose from 'mongoose';

const signature = key => JSON.stringify(Object.entries(key));

/**
 * Compare the indexes that really exist in MongoDB with the ones the Mongoose schemas declare.
 * Mongoose only ever CREATES indexes; it never removes ones left behind by older versions of the project.
 * A leftover UNIQUE index on a field the current schema no longer sets (value null/missing) lets exactly one
 * document in and rejects the next insert with E11000 -- the classic "second record already exists" bug.
 *
 * apply:false (default) only reports. apply:true drops stale UNIQUE indexes; dropAll:true drops every stale index.
 */
export async function auditIndexes({ apply = false, dropAll = false } = {}) {
  const findings = [];
  for (const model of Object.values(mongoose.models)) {
    const declared = new Set(model.schema.indexes().map(([fields]) => signature(fields)));
    let existing;
    try { existing = await model.collection.indexes(); }
    catch (e) { if (e?.codeName === 'NamespaceNotFound' || e?.code === 26) continue; throw e; } // collection not created yet
    for (const idx of existing) {
      if (idx.name === '_id_' || declared.has(signature(idx.key))) continue;
      if (idx.expireAfterSeconds !== undefined && /expiresAt/.test(Object.keys(idx.key).join())) continue;
      const finding = { collection: model.collection.collectionName, name: idx.name, key: idx.key, unique: Boolean(idx.unique), dropped: false };
      if (apply && (idx.unique || dropAll)) { await model.collection.dropIndex(idx.name); finding.dropped = true; }
      findings.push(finding);
    }
  }
  return findings;
}
