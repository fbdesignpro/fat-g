// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M19b's trace shares (M19b, C2): its output folder, and the files it writes into the scratch
// folder a session runs in, beside M10's own (`sample.txt` and the notes). Plain Node; nothing here
// is application code.
//
// The files themselves are in tests/fixtures/project-files.mjs since M19b's build (C46), where the
// replay fakes' tests and the smoke run read them too: one copy. Each gained a marker sentence at
// its end there, after K2's captures were taken; a trace run again writes the files as they are now.
import path from 'node:path';
import { SPIKES_DIR } from '../../m10/lib/paths.mjs';

export { FILES, FUNCTION_LINE } from '../../../tests/fixtures/project-files.mjs';

export const M19B_DIR = path.join(SPIKES_DIR, 'output', 'm19b');
