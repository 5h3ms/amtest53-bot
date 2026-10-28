import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { backfillMaintenanceIndex, MAINTENANCE_READY_KEY } from '../src/maintenance-migration.js';
import { MAINTENANCE_INDEX_VERSION } from '../src/maintenance-index.js';
import { FirestoreStateStore } from '../src/storage.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let project: string | undefined, apply = false, disableIndex = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--disable-index' && !disableIndex) disableIndex = true;
    else if (arg === '--project' && project === undefined && args[index + 1]) project = args[++index];
    else throw new Error('Expected explicit --project and one optional action');
  }
  if (apply && disableIndex) throw new Error('Migration actions are mutually exclusive');
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  const loopback = emulator?.match(/^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/);
  const safeEmulator = Boolean(loopback && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535);
  if (!project || (project !== 'amtest53-bot' && !(project.startsWith('demo-') && safeEmulator)) ||
    (project === 'amtest53-bot' && emulator !== undefined)) throw new Error('Migration target is not allowed');
  if (project.startsWith('demo-') && !safeEmulator) throw new Error('Demo migration requires a loopback emulator');
  const credential = safeEmulator ? undefined : applicationDefault();
  const app = initializeApp({ projectId: project, ...(credential ? { credential } : {}) }, 'maintenance-backfill');
  try {
    const db = getFirestore(app);
    if (disableIndex) {
      await new FirestoreStateStore(db).update(MAINTENANCE_READY_KEY, () => ({
        state: { ready: false, version: MAINTENANCE_INDEX_VERSION, disabledAt: Date.now() }, result: undefined,
      }));
      console.log(JSON.stringify({ ready: false }));
      return;
    }
    const result = await backfillMaintenanceIndex(db, { apply });
    console.log(JSON.stringify(result));
    if (result.invalid || result.missing || result.verificationInvalid || result.verificationMissing ||
      (apply && !result.readyPublished)) process.exitCode = 1;
  } finally { await deleteApp(app); }
}

void main().catch(() => {
  console.error('Maintenance migration did not complete. User learning state was not rewritten. Sensitive details suppressed.');
  process.exitCode = 1;
});
