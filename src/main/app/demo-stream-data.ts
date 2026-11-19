// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The stream form's data folder (docs/planning/_archive/M19.md, Design 9; C69), and the form made ready on
// it: what the bootstrap loads for `do-run-stream.bat`. Development and smoke builds only — it is
// loaded by a dynamic import behind `__FATG_SMOKE_HOOKS__` (src/main/index.ts), and a release
// bundle holds neither it nor the form (src/main/sessions/demo-stream.ts), which the package audit
// refuses there as it refuses the demo source.
//
// It is the one part of the form that writes files, and it writes into the form's own throwaway
// folder alone: any other folder is refused, so neither the development data folder nor the packaged
// app's is ever touched. Electron-free: the folder arrives as an option.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIRST_INSTANCE_ID } from '@shared/contracts/instances';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { createStreamForm, loadFixture, STREAM_CHATS, STREAM_IMAGE_FILES, STREAM_MODEL, STREAM_PROJECT, STREAM_PROVIDER, STREAM_SESSION, type StreamForm, type StreamImage } from '../sessions/demo-stream';
import { STREAM_DATA_FOLDER } from './identity';

/**
 * Makes the form's data folder what every run starts from (C69): its records, with one project on a
 * scratch folder beside them, its session, and two empty chats beside it for a plan they share
 * (decision 0029), and no conversation store. Only the form's own folder
 * is ever touched: any other is refused. Whatever else the folder holds — its preferences, the
 * browser's own files — is left.
 */
export function prepareStreamData(dir: string, now: number = Date.now()): void {
  if (path.basename(dir) !== STREAM_DATA_FOLDER) throw new Error('the stream form writes to its own data folder alone');
  const project = path.join(dir, 'project');
  mkdirSync(dir, { recursive: true });
  for (const name of [RECORDS_FILE, 'conversations.sqlite', 'conversations.sqlite-wal', 'conversations.sqlite-shm']) rmSync(path.join(dir, name), { force: true });
  // And its images (M23, C30): the store that named them goes, so they go too.
  rmSync(path.join(dir, ATTACHMENTS_FOLDER), { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const at = new Date(now).toISOString();
  const session = (id: string, name: string, made: number) => ({
    id, projectId: STREAM_PROJECT, providerId: STREAM_PROVIDER, instanceId: FIRST_INSTANCE_ID, reference: null, folder: null, configFolder: null, model: STREAM_MODEL, effort: null, speed: null,
    name, nameSource: 'user', starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: made, lastActiveAt: made, lastTurn: null,
  });
  writeFileSync(path.join(dir, RECORDS_FILE), `${JSON.stringify({
    schemaVersion: RECORDS_VERSION,
    minReaderVersion: RECORDS_VERSION,
    projects: [{ id: STREAM_PROJECT, name: 'Stream fixture', color: 'teal', hidden: false, providers: [STREAM_PROVIDER], roots: [{ path: project, trust: { answer: 'trusted', answeredAt: at } }] }],
    sessions: [session(STREAM_SESSION, 'Fixture streams', now), ...STREAM_CHATS.map((chat, n) => session(chat.id, chat.name, now - 1_000 * (n + 1)))],
  }, null, 2)}\n`, 'utf8');
}

export interface PrepareStreamFormOptions {
  /** The form's data folder: `fatg-stream`, under the temporary folder (./identity.ts). */
  readonly dir: string;
  /** Where the fixture is: the launcher's word. */
  readonly fixtureFile: string | undefined;
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/** The stream form, made ready before fat-g starts: its fixture read, its data folder as every run finds it, its provider defined. */
export async function prepareStreamForm({ dir, fixtureFile, log = console }: PrepareStreamFormOptions): Promise<StreamForm> {
  if (fixtureFile === undefined || fixtureFile === '') throw new Error('no fixture was named: start the stream form with do-run-stream.bat');
  const fixture = await loadFixture(fixtureFile);
  prepareStreamData(dir);
  return createStreamForm({ fixture, images: readImages(fixtureFile, log), log });
}

/**
 * The fixture's two images (M23, C30), from tests/fixtures/attachments beside the conversations'
 * fixture: none where they cannot be read, and the form goes on without its image turn.
 */
function readImages(fixtureFile: string, log: Pick<Console, 'warn'>): StreamImage[] {
  const folder = path.join(path.dirname(fixtureFile), '..', ATTACHMENTS_FOLDER);
  try {
    return STREAM_IMAGE_FILES.map((name) => ({ name, bytes: new Uint8Array(readFileSync(path.join(folder, name))) }));
  } catch {
    log.warn('[stream] the fixture’s images could not be read: the form goes on without them');
    return [];
  }
}
