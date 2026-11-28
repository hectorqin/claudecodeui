import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { sessionsService } from '@/modules/providers/index.js';

const LEAD_PROJECT = '/workspace/acme-app';
const WORKTREE = '/workspace/acme-app-worktrees/coder';

async function withDatabase(run: () => Promise<void>) {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'project-child-sessions-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

/** A lead in one project with a cross-project codex worker and a same-project claude reviewer. */
function seedFamily() {
  sessionsService.createAppSession('claude', LEAD_PROJECT, 'Use coagent to delegate the work');
  const lead = sessionsDb.getSessionsByProjectPath(LEAD_PROJECT)[0].session_id;
  const coder = sessionsService.createAppSession('codex', WORKTREE, 'coder task', { parentSessionId: lead }).sessionId;
  const reviewer = sessionsService.createAppSession('claude', LEAD_PROJECT, 'reviewer task', { parentSessionId: lead }).sessionId;
  for (const [index, id] of [lead, coder, reviewer].entries()) {
    getConnection().prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE session_id = ?')
      .run(`2026-11-2${index}T00:00:00.000Z`, `2026-11-2${index}T00:00:00.000Z`, id);
  }
  return { lead, coder, reviewer };
}

test('project lists nest children under their parent and leave them out of their own project page', async () => {
  await withDatabase(async () => {
    const { lead, coder, reviewer } = seedFamily();

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const leadProject = projects.find((project) => project.path === LEAD_PROJECT)!;
    const worktree = projects.find((project) => project.path === WORKTREE)!;

    assert.deepEqual(leadProject.sessions.map((session) => session.id), [lead]);
    assert.deepEqual(leadProject.sessionMeta, { total: 1, hasMore: false });
    assert.equal(leadProject.childSessionCount, 1, 'the same-project reviewer is listed under the lead');
    const [leadSummary] = leadProject.sessions;
    assert.equal(leadSummary.parentSessionId, null);
    assert.deepEqual(
      leadSummary.childSessions.map((child) => ({
        id: child.id, provider: child.provider, projectPath: child.projectPath, parentSessionId: child.parentSessionId,
      })),
      [
        { id: coder, provider: 'codex', projectPath: WORKTREE, parentSessionId: lead },
        { id: reviewer, provider: 'claude', projectPath: LEAD_PROJECT, parentSessionId: lead },
      ],
    );
    assert.equal(leadSummary.childSessions[0].summary, 'coder task');
    assert.equal(leadSummary.childSessions[0].projectId, worktree.projectId);
    assert.equal(leadSummary.childSessions[0].lastActivity, '2026-11-21T00:00:00.000Z');

    // The worktree holds only a child: no sessions of its own, which the sidebar uses to hide it.
    assert.deepEqual(worktree.sessions, []);
    assert.deepEqual(worktree.sessionMeta, { total: 0, hasMore: false });
    assert.equal(worktree.childSessionCount, 1);

    const page = await getProjectSessionsPage(leadProject.projectId, { limit: 20, offset: 0 });
    assert.deepEqual(page.sessions[0].childSessions.map((child) => child.id), [coder, reviewer]);

    // The Conversations feed stays flat and still lists every session.
    assert.deepEqual(sessionsService.listRecentSessions(20, 0).conversations.map((item) => item.sessionId).sort(), [lead, coder, reviewer].sort());
  });
});

test('archived children are not listed; an archived parent releases its children to their own project', async () => {
  await withDatabase(async () => {
    const { lead, coder, reviewer } = seedFamily();
    sessionsDb.updateSessionIsArchived(reviewer, true);

    let projects = await getProjectsWithSessions({ skipSynchronization: true });
    let leadProject = projects.find((project) => project.path === LEAD_PROJECT)!;
    assert.deepEqual(leadProject.sessions[0].childSessions.map((child) => child.id), [coder]);
    assert.equal(leadProject.childSessionCount, 0);

    const archived = sessionsService.listArchivedSessions();
    assert.deepEqual(archived.map((item) => [item.sessionId, item.parentSessionId]), [[reviewer, lead]]);

    sessionsDb.updateSessionIsArchived(lead, true);
    projects = await getProjectsWithSessions({ skipSynchronization: true });
    const worktree = projects.find((project) => project.path === WORKTREE)!;
    assert.deepEqual(worktree.sessions.map((session) => [session.id, session.parentSessionId]), [[coder, null]]);
    assert.equal(worktree.childSessionCount, 0);
    leadProject = projects.find((project) => project.path === LEAD_PROJECT)!;
    assert.deepEqual(leadProject.sessions, []);
  });
});

test('pinned summaries say which pins are attached children', async () => {
  await withDatabase(async () => {
    const { lead, coder } = seedFamily();
    const userId = Number(userDb.createUser('pinner', 'unused-hash').id);
    sessionsService.setSessionPinned(userId, lead, true);
    sessionsService.setSessionPinned(userId, coder, true);

    const pins = sessionsService.listPinnedSessions(userId);
    assert.deepEqual(pins.map((pin) => [pin.sessionId, pin.parentSessionId]), [[coder, lead], [lead, null]]);
  });
});
