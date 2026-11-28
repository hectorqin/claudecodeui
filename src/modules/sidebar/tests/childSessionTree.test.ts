import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChildSessionSummary, Project, SessionWithProvider } from '@/shared/types';
import { buildProjectSessionTree } from '@/modules/sidebar/utils/projectSessionTree';
import { hasActiveSessionInFamily, isChildOnlyProject } from '@/modules/sidebar/utils/sidebarProjectFormatting';

const child = (id: string, parent: string, overrides: Partial<ChildSessionSummary> = {}): ChildSessionSummary => ({
  id, provider: 'codex', summary: id, lastActivity: '2026-11-28T00:00:00.000Z',
  projectId: 'worktree', projectPath: '/workspace/acme-app-worktrees/coder', parentSessionId: parent,
  forkedFromSessionId: null, childSessions: [], ...overrides,
});
const session = (id: string, overrides: Partial<SessionWithProvider> = {}): SessionWithProvider => ({
  id, summary: id, __provider: 'claude', ...overrides,
});
const shape = (sessions: SessionWithProvider[]) => buildProjectSessionTree(sessions, 'acme').map((row) => (
  [row.session.id, row.parentId, row.depth, row.isChildSession, row.session.__provider, row.session.__projectId ?? null]
));

test('children from another project and provider hang under their parent, in the order they were started', () => {
  const lead = session('lead', { childSessions: [
    child('coder', 'lead'),
    child('reviewer', 'lead', { provider: 'claude', projectId: 'acme', projectPath: '/workspace/acme-app' }),
  ] });
  assert.deepEqual(shape([session('newer'), lead]), [
    ['newer', null, 0, false, 'claude', null],
    ['lead', null, 0, false, 'claude', null],
    ['coder', 'lead', 1, true, 'codex', 'worktree'],
    ['reviewer', 'lead', 1, true, 'claude', 'acme'],
  ]);
  const rows = buildProjectSessionTree([lead], 'acme');
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[2].isLastSibling, true);
  assert.equal(rows[1].session.projectPath, '/workspace/acme-app-worktrees/coder');
});

test('grandchildren nest under their own parent', () => {
  const lead = session('lead', { childSessions: [child('coder', 'lead', { childSessions: [child('helper', 'coder', { provider: 'opencode' })] })] });
  assert.deepEqual(shape([lead]).map((row) => row.slice(0, 4)), [
    ['lead', null, 0, false], ['coder', 'lead', 1, true], ['helper', 'coder', 2, true],
  ]);
});

test('a session attached to a parent is shown only under that parent, even when it is also a fork', () => {
  // `stray` reached this list (e.g. an off-page pin) but belongs under `lead`.
  const stray = session('stray', { parentSessionId: 'lead', forkedFromSessionId: 'base' });
  assert.deepEqual(shape([stray, session('base')]).map((row) => row[0]), ['base']);
});

test('fork nesting keeps working among a parent\'s children and alongside its own forks', () => {
  const lead = session('lead', { childSessions: [
    child('coder', 'lead'),
    // A fork of a child inherits the child's parent and nests under its source.
    child('coder-fork', 'lead', { forkedFromSessionId: 'coder' }),
    child('reviewer', 'lead'),
  ] });
  const leadFork = session('lead-fork', { forkedFromSessionId: 'lead' });
  assert.deepEqual(shape([leadFork, lead]).map((row) => row.slice(0, 4)), [
    ['lead', null, 0, false],
    ['lead-fork', 'lead', 1, false],
    ['coder', 'lead', 1, true],
    ['coder-fork', 'coder', 2, true],
    ['reviewer', 'lead', 1, true],
  ]);
});

test('a repeated child is listed once', () => {
  const lead = session('lead', { childSessions: [child('coder', 'lead', { childSessions: [child('coder', 'coder')] }), child('coder', 'lead')] });
  assert.deepEqual(shape([lead]).map((row) => row[0]), ['lead', 'coder']);
});

const project = (overrides: Partial<Project>): Project => ({
  projectId: 'p', displayName: 'p', fullPath: '/p', sessions: [], sessionMeta: { total: 0, hasMore: false }, ...overrides,
});

test('a project whose only sessions are children elsewhere is hidden; empty and mixed projects are not', () => {
  assert.equal(isChildOnlyProject(project({ childSessionCount: 2 })), true);
  assert.equal(isChildOnlyProject(project({ childSessionCount: 0 })), false, 'a new, empty project stays listed');
  assert.equal(isChildOnlyProject(project({})), false);
  assert.equal(isChildOnlyProject(project({ childSessionCount: 1, sessions: [{ id: 'own' }], sessionMeta: { total: 1, hasMore: false } })), false);
  assert.equal(isChildOnlyProject(project({ childSessionCount: 1, sessionMeta: { total: 3, hasMore: true } })), false);
});

test('archived children never reach the tree, so a parent with only archived children shows none', () => {
  // The server leaves archived children out of `childSessions`; the parent is then a plain row.
  const rows = buildProjectSessionTree([session('lead', { childSessions: [] })], 'acme');
  assert.deepEqual(rows.map((row) => [row.session.id, row.hasChildren]), [['lead', false]]);
});

test('a running child keeps its parent in the running view', () => {
  const lead = session('lead', { childSessions: [child('coder', 'lead', { childSessions: [child('helper', 'coder')] })] });
  assert.equal(hasActiveSessionInFamily(lead, new Set(['helper'])), true);
  assert.equal(hasActiveSessionInFamily(lead, new Set(['lead'])), true);
  assert.equal(hasActiveSessionInFamily(lead, new Set(['other'])), false);
});
