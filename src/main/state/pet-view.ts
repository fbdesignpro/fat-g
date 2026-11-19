// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the Pet shows (decision 0010): the sessions running or waiting on the user, under their
// projects' names, in the Main window's order. Built from the app state by an ALLOWLIST, field by
// field, like the rest of the Pet's projection (projection.ts): a field added to a session's entry
// later stays out of the Pet until someone decides it belongs there. Of a session it copies what a
// Pet capsule draws and nothing else — never the action's label or detail, which can name a file or
// a command, never a sub-agent, the model, the mode or the context reading, never an avatar's
// reference, which names its folders, and of a provider never its logo or its models.
//
// Pure — no Electron imports. Main sizes the Pet's window from the same view (src/main/windows/pet-fit.ts).
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import type { ProviderPresentation } from '@shared/contracts/catalog';
import { DEFAULT_PET_SIZE, type PetAvatar, type PetPresentation, type PetProject, type PetSession, type PetSummary, type PetView } from '@shared/contracts/pet';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { type ActionWait, type SessionEntry, sessionParts, waitsOnYou } from '@shared/contracts/sessions';

export function petView(snapshot: AppStateSnapshot): PetView {
  const byProject = new Map<string, SessionEntry[]>();
  for (const entry of snapshot.sessions?.sessions ?? []) {
    if (!waitsOnYou(entry)) continue;
    byProject.set(entry.record.projectId, [...(byProject.get(entry.record.projectId) ?? []), entry]);
  }

  const projects: PetProject[] = [];
  const providers = new Set<string>();
  // The visible projects, then the hidden ones, each in stored order, as the Main window lists them.
  const entries = snapshot.records?.projects ?? [];
  for (const entry of [...entries.filter((project) => !hiddenProject(project)), ...entries.filter(hiddenProject)]) {
    if (entry.kind !== 'project') continue;
    const listed = byProject.get(entry.id);
    if (listed === undefined) continue;
    // Starred first, then stored order: the order of the Main window's active capsules.
    const sessions = sessionParts(listed, 0).active.map(sessionForPet);
    for (const session of sessions) providers.add(session.record.providerId);
    projects.push({ id: entry.id, name: entry.name, sessions });
  }

  const presentation: Record<string, PetPresentation> = {};
  for (const id of providers) {
    const found = snapshot.catalog?.providers.find((provider) => provider.id === id)?.presentation;
    if (found !== undefined) presentation[id] = presentationForPet(found);
  }
  return { size: snapshot.petSize ?? DEFAULT_PET_SIZE, projects, presentation };
}

function hiddenProject(entry: ProjectEntryView): boolean {
  return entry.kind === 'project' && entry.hidden;
}

function sessionForPet({ record, summary, avatar }: SessionEntry): PetSession {
  return {
    record: { id: record.id, providerId: record.providerId, name: record.name, nameSource: record.nameSource, createdAt: record.createdAt, speed: record.speed },
    summary: summaryForPet(summary),
    avatar: avatar === null ? null : avatarForPet(avatar),
  };
}

function summaryForPet(summary: SessionEntry['summary']): PetSummary {
  const { turnWait, attention, action, planWait, displayHold } = summary;
  return {
    status: summary.status,
    turnStartedAt: summary.turnStartedAt,
    ...(turnWait === undefined ? {} : { turnWait: { turnId: turnWait.turnId, ms: turnWait.ms, since: turnWait.since } }),
    activeWorkers: summary.activeWorkers,
    attention: attention === null ? null : { kind: attention.kind, count: attention.count, acknowledged: attention.acknowledged, ...(attention.flash === false ? { flash: false as const } : {}) },
    action: action === null ? null : { kind: action.kind, ...safeWait(action.wait) },
    ...(displayHold === undefined ? {} : { displayHold: { kind: displayHold.kind, ...safeWait(displayHold.wait), until: displayHold.until } }),
    ...(planWait === undefined ? {} : { planWait }),
    effort: summary.effort,
  };
}

/** Deliberate nested allowlist: an adapter's or future summary's extra fields cannot cross it. */
function safeWait(wait: ActionWait | undefined): { readonly wait?: ActionWait } {
  if (wait?.reason === 'subagents') return { wait: { reason: 'subagents', ...(wait.count === undefined ? {} : { count: wait.count }) } };
  return wait?.reason === 'provider' ? { wait: { reason: 'provider' } } : {};
}

/** The files to draw and the overlay's look, which the family's file sets and the model's ids word. */
function avatarForPet(avatar: ResolvedAvatar): PetAvatar {
  return { portrait: avatar.portrait, small: avatar.small, ...(avatar.overlay === undefined ? {} : { overlay: avatar.overlay }) };
}

function presentationForPet(presentation: ProviderPresentation): PetPresentation {
  return { barColor: presentation.barColor, icon: presentation.icon, ...(presentation.logo === undefined ? {} : { logo: presentation.logo }), ...(presentation.stream === undefined ? {} : { stream: presentation.stream }) };
}
