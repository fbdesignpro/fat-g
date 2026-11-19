// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Gates A and B on Claude (docs/planning/_archive/M22e.md, Build steps 5, 6; V5; C1–C12, C25, C29, C31, C43): a
// review through the runtime and the review service, on the real Claude adapter and process layer,
// against the replay fake — a plan raised through a request, reviewed in a session under Read only,
// a settling note and an asking one sent, the findings decided and integrated as the request's
// feedback, and the review kept across a restart. The records, the conversation store, the plan
// store and every service are the app's own.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planOf } from '@shared/contracts/interaction';
import type { ReviewView } from '@shared/contracts/review';
import { type App, launchApp, placeRecords, presetOf, S, sessionEntry, until } from '../../sessions/app';
import { claudeHarness, type Harness, promptOf } from './harness';

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet', effort: 'medium', name: 'Plan chat', nameSource: 'user' })]);
const launch = (h: Harness): App => { const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet }); apps.push(app); return app; };
const idle = (app: App, id: string) => until(() => !app.service.isRunning(id), 'the session coming to rest', 30_000);
const view = (app: App, reviewId: string): ReviewView => { const answer = app.reviews.read({ reviewId }); if (answer.status !== 'read') throw new Error(answer.status); return answer.review; };

describe('a review on Claude, end to end (Gates A and B)', () => {
  it('reviews a plan its request holds, takes a settling note’s round and an asking note’s, integrates as the request’s feedback, and keeps it across a restart', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    expect(await app.runtime.send(S(1), promptOf('m22b-plan-ask-first', h.project), { plan: true })).toEqual({ status: 'accepted' });
    await until(() => app.read(1).items.some((item) => planOf(item)?.outcome === 'pending'), 'the plan’s request', 30_000);
    const line = app.read(1).items.find((item) => planOf(item) !== null);
    const planId = line === undefined ? '' : planOf(line)?.planId ?? '';

    const started = await app.reviews.start({ sessionId: S(1), preset: presetOf(app, S(1)), planId, version: 1, revision: app.workflow.view(planId)?.revision ?? 0 });
    if (started.status !== 'started') throw new Error(started.reason);
    const reviewer = started.sessionId;
    await until(() => view(app, started.reviewId).state !== 'running' || undefined, 'the review’s first round', 60_000);
    await idle(app, reviewer);
    const { reviewId } = started;
    expect(view(app, reviewId)).toMatchObject({ state: 'findings', live: true });
    expect(app.runtime.chatMode(app.service.record(reviewer)!)).toEqual({ id: 'read-only', source: 'chat' });
    const ids = view(app, reviewId).rounds[0]?.findings.map((finding) => finding.id) ?? [];

    app.reviews.mark({ reviewId, findingId: ids[0] ?? '', mark: 'accepted' });
    app.reviews.note({ reviewId, findingId: ids[1] ?? '', note: 'This is minor.' });
    expect(await app.reviews.send({ reviewId })).toEqual({ status: 'sent' });
    await until(() => view(app, reviewId).rounds.length === 2 || undefined, 'the settling note’s round', 60_000);
    await idle(app, reviewer);
    const settled = view(app, reviewId).rounds[1];
    expect(settled?.marks[ids[0] ?? '']).toBe('accepted');
    expect(settled?.findings.some((finding) => finding.was !== undefined && finding.was !== finding.id)).toBe(true);

    app.reviews.note({ reviewId, findingId: settled?.findings.find((finding) => settled.marks[finding.id] === 'open')?.id ?? '', note: 'Why this tier?' });
    expect(await app.reviews.send({ reviewId })).toEqual({ status: 'sent' });
    await until(() => view(app, reviewId).rounds.length === 3 || undefined, 'the asking note’s round', 60_000);
    await idle(app, reviewer);

    // Decided and integrated as the request's feedback: the request's turn plans on.
    const third = view(app, reviewId).rounds[2];
    for (const finding of third?.findings ?? []) if (third?.marks[finding.id] === 'open') app.reviews.mark({ reviewId, findingId: finding.id, mark: 'accepted' });
    expect(view(app, reviewId).offers[0]).toMatchObject({ target: { sessionId: S(1) }, route: 'decision' });
    expect(await app.reviews.integrate({ reviewId, target: { sessionId: S(1) } })).toMatchObject({ status: 'sent' });
    await until(() => view(app, reviewId).integrations[0]?.state !== 'sent' || undefined, 'the integration’s end', 60_000);
    expect(view(app, reviewId).integrations[0]).toMatchObject({ state: 'integrated', produced: 2 });
    expect(app.planStore.get(planId)?.versions[1]).toMatchObject({ cause: 'integration', revises: 1 });

    const before = view(app, reviewId);
    await app.service.settled();
    apps = apps.filter((one) => one !== app);
    await app.quit();
    const again = launch(h);
    expect(view(again, reviewId)).toMatchObject({ rounds: before.rounds, integrations: before.integrations });
  }, 300_000);
});
