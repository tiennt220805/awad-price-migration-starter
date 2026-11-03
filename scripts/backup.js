// Consistent copy of the live database, taken while instances keep serving:
//   DB_PATH=/abs/app.db node scripts/backup.js /abs/path/backup-before-003.db
// VACUUM INTO reads a snapshot inside one read transaction, so it is safe with WAL
// and writers running. Take one before the contract step (migration 003).
import { existsSync } from 'node:fs';
import { open } from '../src/db.js';

const target = process.argv[2];
if (!target || !target.startsWith('/')) { console.error('usage: node scripts/backup.js /absolute/target.db'); process.exit(2); }
if (existsSync(target)) { console.error(`${target} exists; refusing to overwrite`); process.exit(2); }
const db = open();
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
console.log(`backup written: ${target}`);
