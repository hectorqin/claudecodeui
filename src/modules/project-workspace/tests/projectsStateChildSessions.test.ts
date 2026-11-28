import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import type { Project, ProjectSession } from '@/shared/types';

const mocks = vi.hoisted(() => ({ projects: vi.fn(), sessionDetails: vi.fn(), rename: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: {
  projects: mocks.projects, projectSessions: () => Promise.resolve({ ok: false }), renameSession: mocks.rename,
  projectTaskmaster: () => Promise.resolve({ ok: false }), sessionDetails: mocks.sessionDetails,
} }));

const coder = {
  id: 'coder', provider: 'codex' as const, summary: 'coder', lastActivity: '2026-11-27T00:00:00Z',
  projectId: 'worktree', projectPath: '/repo-worktrees/coder', parentSessionId: 'lead',
};
const lead: ProjectSession = { id: 'lead', summary: 'Lead', provider: 'claude', childSessions: [coder] };
const acme: Project = {
  projectId: 'acme', displayName: 'acme', path: '/repo', fullPath: '/repo',
  sessions: [lead], sessionMeta: { total: 1, hasMore: false }, childSessionCount: 0,
};
// Listed by the server, but holding only `coder`, which the sidebar shows under `lead`.
const worktree: Project = {
  projectId: 'worktree', displayName: 'coder', path: '/repo-worktrees/coder', fullPath: '/repo-worktrees/coder',
  sessions: [], sessionMeta: { total: 0, hasMore: false }, childSessionCount: 1,
};
const listeners = new Set<(event: never) => void>();
const subscribe = (listener: (event: never) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const emit = (event: unknown) => act(() => listeners.forEach((listener) => listener(event as never)));
const worktreeRef = { projectId: 'worktree', path: '/repo-worktrees/coder', fullPath: '/repo-worktrees/coder', displayName: 'coder', isStarred: false };

const start = async (projects: Project[] = [acme, worktree]) => {
  mocks.projects.mockResolvedValue({ ok: true, json: async () => projects });
  const navigate = vi.fn();
  const hook = renderHook(({ sessionId }: { sessionId?: string }) => useProjectsState({
    sessionId, navigate, subscribe, isMobile: false, isSessionProcessing: () => false,
  }), { initialProps: { sessionId: undefined as string | undefined } });
  await waitFor(() => assert.equal(hook.result.current.projects.length, projects.length));
  return { ...hook, navigate };
};
const leadChildren = (projects: Project[]) => projects.find((project) => project.projectId === 'acme')?.sessions?.[0].childSessions ?? [];

beforeEach(() => {
  localStorage.clear(); listeners.clear(); vi.clearAllMocks();
  mocks.rename.mockResolvedValue({ ok: true });
});

test('a child upsert updates the child under its parent and never lists it in its own project', async () => {
  const { result } = await start();
  emit({
    kind: 'session_upserted', sessionId: 'coder', providerSessionId: 'native-coder', provider: 'codex',
    session: { id: 'coder', summary: 'coder renamed', lastActivity: '2026-11-28T00:00:00Z', parentSessionId: 'lead', childSessions: [] },
    project: worktreeRef,
  });
  assert.deepEqual(leadChildren(result.current.projects).map((child) => [child.id, child.summary, child.projectPath]), [
    ['coder', 'coder renamed', '/repo-worktrees/coder'],
  ]);
  assert.deepEqual(result.current.projects.find((project) => project.projectId === 'worktree')?.sessions, []);

  // A second worker the client has not seen, in a project it does not know: no project is created for it.
  emit({
    kind: 'session_upserted', sessionId: 'reviewer', provider: 'claude',
    session: { id: 'reviewer', summary: 'reviewer', lastActivity: '2026-11-28T00:01:00Z', parentSessionId: 'lead' },
    project: { ...worktreeRef, projectId: 'other-wt', path: '/repo-worktrees/reviewer', fullPath: '/repo-worktrees/reviewer' },
  });
  assert.deepEqual(leadChildren(result.current.projects).map((child) => [child.id, child.provider, child.projectId]), [
    ['coder', 'codex', 'worktree'], ['reviewer', 'claude', 'other-wt'],
  ]);
  assert.equal(result.current.projects.length, 2);
});

test('an empty title upsert keeps the shown child title, and archiving a child drops it without touching totals', async () => {
  const { result } = await start();
  emit({
    kind: 'session_upserted', sessionId: 'coder', provider: 'codex',
    session: { id: 'coder', summary: '', lastActivity: '2026-11-28T00:00:00Z', parentSessionId: 'lead' },
    project: worktreeRef,
  });
  assert.equal(leadChildren(result.current.projects)[0].summary, 'coder');

  act(() => result.current.handleSessionDelete('coder'));
  assert.deepEqual(leadChildren(result.current.projects), []);
  assert.deepEqual(result.current.projects[0].sessionMeta, { total: 1, hasMore: false });
});

test('renaming a child renames it under its parent', async () => {
  const { result } = await start();
  await act(async () => { assert.equal(await result.current.renameSession('coder', 'Worker one'), true); });
  assert.equal(leadChildren(result.current.projects)[0].summary, 'Worker one');
});

test('opening a child selects its own project, even one the sidebar does not list', async () => {
  mocks.sessionDetails.mockResolvedValue({ ok: true, json: async () => ({ data: {
    sessionId: 'coder', provider: 'codex', summary: 'coder',
    project: { projectId: 'worktree', path: '/repo-worktrees/coder', fullPath: '/repo-worktrees/coder', displayName: 'coder' },
  } }) });
  const { result, navigate, rerender } = await start();
  act(() => result.current.handleProjectSelect(result.current.projects[0]));
  act(() => result.current.handleSessionSelect({ id: 'coder', summary: 'coder', __provider: 'codex', __projectId: 'worktree' }));
  assert.deepEqual(navigate.mock.calls.at(-1), ['/session/coder']);

  rerender({ sessionId: 'coder' });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'worktree'));
  assert.equal(result.current.selectedProject?.fullPath, '/repo-worktrees/coder');
  assert.equal(result.current.selectedSession?.id, 'coder');
  assert.equal(result.current.selectedSession?.__provider, 'codex');
  assert.deepEqual(mocks.sessionDetails.mock.calls, [['coder']]);
});

test('on mobile, opening a same-project child closes the drawer and keeps the chosen session', async () => {
  mocks.projects.mockResolvedValue({ ok: true, json: async () => [acme, worktree] });
  const navigate = vi.fn();
  const { result } = renderHook(() => useProjectsState({
    sessionId: undefined, navigate, subscribe, isMobile: true, isSessionProcessing: () => false,
  }));
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  act(() => result.current.handleProjectSelect(result.current.projects[0]));
  act(() => result.current.setSidebarOpen(true));

  const reviewer: ProjectSession = { id: 'reviewer', summary: 'reviewer', __provider: 'claude', __projectId: 'acme' };
  act(() => result.current.handleSessionSelect(reviewer));
  assert.equal(result.current.sidebarOpen, true, 'a plain same-project pick leaves the drawer as it was');

  act(() => result.current.handleSessionSelect(reviewer, { closeSidebar: true }));
  assert.equal(result.current.sidebarOpen, false);
  assert.equal(result.current.selectedSession?.id, 'reviewer');
  assert.equal(result.current.selectedProject?.projectId, 'acme');
  assert.deepEqual(navigate.mock.calls.at(-1), ['/session/reviewer']);
});
