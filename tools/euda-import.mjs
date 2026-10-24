// Imports EU Data Act portal files into the database, including the big one-off "full request" files that are too
// large to load inside the server: node --max-old-space-size=4096 tools/euda-import.mjs [data/euda]
import path from 'node:path';
import { ingestDir } from '../server/cardata.mjs';
import { ROOT } from '../server/lib.mjs';

const dir = process.argv[2] || path.join(ROOT, 'data', 'euda');
console.log('imported', ingestDir(dir, { maxBytes: Infinity }), 'readings');
