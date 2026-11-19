// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Gates A and B on Codex (docs/planning/_archive/M22e.md, Build steps 5, 6; V5; C1–C12, C25, C29, C31, C43, C49):
// a review through the runtime and the review service, on the real Codex adapter and process layer,
// against the replay fake — a plan made, reviewed, a settling note and an asking one sent, the
// findings decided and integrated into the plan's own chat as its line's feedback, and all of it
// kept across a restart; a reviewer and an integrator that ask first, carried on through their
// cards. The records, the conversation store, the plan store and every service are the app's own.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planOf, questionOf } from '@shared/contracts/interaction';
import type { ReviewView } from '@shared/contracts/review';
import { type App, launchApp, placeRecords, presetOf, S, sessionEntry } from '../sessions/app';
import { codexHarness, eventually, type Harness, promptOf } from './harness';

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
});

const WORDS = promptOf('m22b-codex-modes');
const dataDir = (h: Harness) => path.join(h.dir, 'records');
/** One chat under Read only, which Codex plans in, as a review's reviewer reads in. */
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-luna', effort: 'medium', name: 'Plan chat', nameSource: 'user' })], { permissionModes: { codex: 'read-only' } });
const launch = (h: Harness): App => { const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet }); apps.push(app); return app; };
const idle = (app: App, id: string) => eventually(() => !app.service.isRunning(id), 30_000, 'the session coming to rest');
const view = (app: App, reviewId: string): ReviewView => { const answer = app.reviews.read({ reviewId }); if (answer.status !== 'read') throw new Error(answer.status); return answer.review; };

/** S(1)'s plan, made by a plan turn and waiting for its decision. */
async function planned(app: App): Promise<string> {
  expect(await app.runtime.send(S(1), WORDS, { plan: true })).toEqual({ status: 'accepted' });
  await idle(app, S(1));
  const line = app.read(1).items.filter((item) => planOf(item) !== null).at(-1);
  const body = line === undefined ? null : planOf(line);
  expect(body).toMatchObject({ outcome: 'pending', version: 1 });
  return body?.planId ?? '';
}
/** A review of it, started from S(1), its first round arrived. */
async function reviewed(app: App, planId: string): Promise<{ readonly reviewId: string; readonly reviewer: string }> {
  const started = await app.reviews.start({ sessionId: S(1), preset: presetOf(app, S(1)), planId, version: 1, revision: app.workflow.view(planId)?.revision ?? 0 });
  if (started.status !== 'started') throw new Error(started.reason);
  await eventually(() => view(app, started.reviewId).state !== 'running', 60_000, 'the review’s first round');
  await idle(app, started.sessionId);
  return { reviewId: started.reviewId, reviewer: started.sessionId };
}

describe('a review on Codex, end to end (Gates A and B)', () => {
  it('reviews a plan, takes a settling note’s round and an asking note’s, integrates into the plan’s own chat, and keeps it all across a restart', async () => {
    const h = harness = await codexHarness();
    place(h);
    const app = launch(h);
    const planId = await planned(app);
    const { reviewId, reviewer } = await reviewed(app, planId);
    const first = view(app, reviewId);
    expect(first).toMatchObject({ state: 'findings', live: true });
    // The reviewer: on the chat's preset, named, under Read only.
    expect(app.service.record(reviewer)).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', name: expect.stringMatching(/^Review of Plan: .+ v1$/) as string, nameSource: 'generated' });
    expect(app.runtime.chatMode(app.service.record(reviewer)!)).toEqual({ id: 'read-only', source: 'chat' });
    const ids = first.rounds[0]?.findings.map((finding) => finding.id) ?? [];
    expect(ids.length).toBeGreaterThan(2);

    // The settling note: K2's round moves one finding under a new id naming `was`, the marks carried.
    app.reviews.mark({ reviewId, findingId: ids[0] ?? '', mark: 'accepted' });
    app.reviews.note({ reviewId, findingId: ids[1] ?? '', note: 'This is minor.' });
    expect(await app.reviews.send({ reviewId })).toEqual({ status: 'sent' });
    await eventually(() => view(app, reviewId).rounds.length === 2, 60_000, 'the settling note’s round');
    await idle(app, reviewer);
    const settled = view(app, reviewId);
    expect(settled.rounds[0]?.live).toBe(false);
    expect(settled.rounds[1]?.marks[ids[0] ?? '']).toBe('accepted');
    expect(settled.rounds[1]?.findings.some((finding) => finding.was !== undefined && finding.was !== finding.id)).toBe(true);

    // The asking note: prose above the round sent again.
    const latest = settled.rounds[1]?.findings.map((finding) => finding.id) ?? [];
    app.reviews.note({ reviewId, findingId: latest.find((id) => settled.rounds[1]?.marks[id] === 'open') ?? '', note: 'Why this tier?' });
    expect(await app.reviews.send({ reviewId })).toEqual({ status: 'sent' });
    await eventually(() => view(app, reviewId).rounds.length === 3, 60_000, 'the asking note’s round');
    await idle(app, reviewer);

    // Every finding decided, then integrated into the plan's own chat, as its line's feedback.
    const third = view(app, reviewId).rounds[2];
    for (const id of third?.findings.map((finding) => finding.id) ?? []) if (third?.marks[id] === 'open') app.reviews.mark({ reviewId, findingId: id, mark: 'accepted' });
    expect(view(app, reviewId).offers[0]).toMatchObject({ target: { sessionId: S(1) }, route: 'decision' });
    const integrated = await app.reviews.integrate({ reviewId, target: { sessionId: S(1) } });
    expect(integrated).toMatchObject({ status: 'sent', sessionId: S(1) });
    await eventually(() => view(app, reviewId).integrations[0]?.state !== 'sent', 60_000, 'the integration’s end');
    await idle(app, S(1));
    expect(view(app, reviewId)).toMatchObject({ staleBy: 2, integrations: [{ state: 'integrated', produced: 2 }] });
    expect(app.planStore.get(planId)?.versions[1]).toMatchObject({ cause: 'integration', revises: 1, integration: { reviewId } });

    // A restart keeps the rounds, the marks, the notes and the integration.
    const before = view(app, reviewId);
    await app.service.settled();
    await app.quit();
    apps = apps.filter((one) => one !== app);
    const again = launch(h);
    expect(view(again, reviewId)).toMatchObject({ rounds: before.rounds, integrations: before.integrations, staleBy: 2 });
  }, 300_000);

  it('carries a reviewer that asks first through its card’s answer, and an integrator that does (C49)', async () => {
    const h = harness = await codexHarness();
    place(h);
    const app = launch(h);
    const planId = await planned(app);
    h.control({ 'review-asks': 1 });
    const started = await app.reviews.start({ sessionId: S(1), preset: presetOf(app, S(1)), planId, version: 1, revision: app.workflow.view(planId)?.revision ?? 0 });
    if (started.status !== 'started') throw new Error(started.reason);
    await idle(app, started.sessionId);
    expect(view(app, started.reviewId)).toMatchObject({ state: 'running', turns: [{ outcome: 'asked' }] });
    const card = app.runtime.read(started.sessionId);
    const asked = card.status === 'read' ? card.items.find((item) => questionOf(item) !== null) : undefined;
    expect(await app.runtime.answer(started.sessionId, asked?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    await eventually(() => view(app, started.reviewId).state === 'findings', 60_000, 'the round after the card’s answer');
    await idle(app, started.sessionId);

    for (const finding of view(app, started.reviewId).rounds[0]?.findings ?? []) app.reviews.mark({ reviewId: started.reviewId, findingId: finding.id, mark: 'accepted' });
    h.control({ 'integration-asks': 1 });
    expect(await app.reviews.integrate({ reviewId: started.reviewId, target: { sessionId: S(1) } })).toMatchObject({ status: 'sent' });
    await idle(app, S(1));
    expect(view(app, started.reviewId).integrations[0]).toMatchObject({ state: 'sent' });
    const read = app.runtime.read(S(1));
    const question = read.status === 'read' ? read.items.filter((item) => questionOf(item)?.outcome === 'open').at(-1) : undefined;
    expect(await app.runtime.answer(S(1), question?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    await eventually(() => view(app, started.reviewId).integrations[0]?.state !== 'sent', 60_000, 'the integration carried on');
    expect(view(app, started.reviewId).integrations[0]).toMatchObject({ state: 'integrated', produced: 2 });
    expect(app.planStore.get(planId)?.versions[1]).toMatchObject({ cause: 'integration' });
  }, 300_000);
});
