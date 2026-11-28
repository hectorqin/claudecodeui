import type { ChildSessionSummary, LLMProvider, Project, ProjectSession } from '@/shared/types';

/**
 * Pure helpers for the child sessions the server nests under their parent
 * session (`ProjectSession.childSessions`). A child may run in another project
 * and on another provider, and is never listed in its own project's
 * `sessions`, so every update to it has to find it under its parent instead.
 *
 * All helpers return the same references when nothing changed, so React state
 * setters can bail out.
 */

type ChildContainer = Pick<ProjectSession, 'childSessions'>;

/** Applies `update` to each child list in the tree under `container` (deepest first); `ownerId` names the list's owner. */
function mapChildTree<T extends ChildContainer>(
  container: T,
  update: (children: ChildSessionSummary[], ownerId: string | null) => ChildSessionSummary[],
  ownerId: string | null,
  seen: Set<string> = new Set(),
): T {
  const children = container.childSessions ?? [];
  let nestedChanged = false;
  const nested = children.map((child) => {
    // Damaged data can repeat a session; visit it once.
    if (seen.has(child.id)) return child;
    seen.add(child.id);
    const next = mapChildTree(child, update, child.id, seen);
    if (next !== child) nestedChanged = true;
    return next;
  });
  const base = nestedChanged ? nested : children;
  const updated = update(base, ownerId);
  if (updated === base && !nestedChanged) return container;
  return { ...container, childSessions: updated };
}

function mapProjectChildTrees(
  projects: Project[],
  update: (children: ChildSessionSummary[], ownerId: string | null) => ChildSessionSummary[],
): Project[] {
  let changedAny = false;
  const next = projects.map((project) => {
    let changed = false;
    const sessions = (project.sessions ?? []).map((session) => {
      const updated = mapChildTree(session, update, String(session.id));
      if (updated !== session) changed = true;
      return updated;
    });
    if (!changed) return project;
    changedAny = true;
    return { ...project, sessions };
  });
  return changedAny ? next : projects;
}

/** The shape of a `session_upserted` event this module reads. */
export type ChildSessionUpsert = {
  sessionId: string;
  providerSessionId?: string | null;
  provider: LLMProvider;
  session: ProjectSession;
  project: { projectId: string; path: string } | null;
};

/**
 * Places an upserted child session under its parent, wherever that parent is
 * loaded (a project's own row, or nested under another child). The child is
 * also dropped from any project's own list it was in. A child whose parent is
 * not loaded is not shown until the parent's page arrives, which embeds it.
 */
export function upsertChildSessionInProjects(projects: Project[], event: ChildSessionUpsert): Project[] {
  const parentId = event.session.parentSessionId;
  if (!parentId) return projects;
  const aliasIds = new Set([event.sessionId, event.providerSessionId, event.session.id].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ));

  // Drop it from a project's own list, where an earlier upsert may have put it.
  let next = projects.map((project) => {
    const sessions = project.sessions ?? [];
    if (!sessions.some((session) => aliasIds.has(String(session.id)))) return project;
    const remaining = sessions.filter((session) => !aliasIds.has(String(session.id)));
    const total = Math.max(0, Number(project.sessionMeta?.total ?? sessions.length) - (sessions.length - remaining.length));
    return {
      ...project,
      sessions: remaining,
      sessionMeta: { ...project.sessionMeta, total, hasMore: remaining.length < total },
    };
  });

  let existing: ChildSessionSummary | undefined;
  next = mapProjectChildTrees(next, (children, ownerId) => {
    if (ownerId === parentId) {
      existing ??= children.find((child) => aliasIds.has(child.id));
      return children;
    }
    // Removed from any other parent (or alias) it was listed under.
    if (!children.some((child) => aliasIds.has(child.id))) return children;
    existing ??= children.find((child) => aliasIds.has(child.id));
    return children.filter((child) => !aliasIds.has(child.id));
  });

  const incomingSummary = typeof event.session.summary === 'string' ? event.session.summary : '';
  const child: ChildSessionSummary = {
    id: event.sessionId,
    provider: event.provider,
    // An upsert can carry an empty title for a moment; keep the one already shown.
    summary: incomingSummary.trim() ? incomingSummary : (existing?.summary ?? ''),
    lastActivity: event.session.lastActivity ?? existing?.lastActivity ?? new Date().toISOString(),
    createdAt: (event.session.createdAt as string | undefined) ?? existing?.createdAt,
    projectId: event.project?.projectId ?? existing?.projectId ?? null,
    projectPath: event.project?.path ?? existing?.projectPath ?? null,
    parentSessionId: parentId,
    forkedFromSessionId: event.session.forkedFromSessionId ?? existing?.forkedFromSessionId ?? null,
    childSessions: event.session.childSessions ?? existing?.childSessions ?? [],
  };

  return mapProjectChildTrees(next, (children, ownerId) => {
    if (ownerId !== parentId) return children;
    const index = children.findIndex((candidate) => aliasIds.has(candidate.id));
    if (index < 0) return [...children, child];
    if (JSON.stringify(children[index]) === JSON.stringify(child)) return children;
    return children.map((candidate, position) => (position === index ? child : candidate));
  });
}

/** Removes a deleted or archived session from every child list it is in. */
export function removeChildSession<T extends ChildContainer>(container: T, sessionId: string): T {
  return mapChildTree(container, (children) => (
    children.some((child) => child.id === sessionId) ? children.filter((child) => child.id !== sessionId) : children
  ), null);
}

/** Writes a confirmed rename onto a child row, wherever it is nested. */
export function renameChildSession<T extends ChildContainer>(container: T, sessionId: string, summary: string): T {
  return mapChildTree(container, (children) => (
    children.some((child) => child.id === sessionId && child.summary !== summary)
      ? children.map((child) => (child.id === sessionId ? { ...child, summary } : child))
      : children
  ), null);
}
