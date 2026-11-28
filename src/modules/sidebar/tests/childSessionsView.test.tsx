import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import type { SessionWithProvider } from '@/shared/types';

const compact = vi.hoisted(() => ({ value: false }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => compact.value }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const t = ((key: string, fallbackOrOptions?: unknown) => (
  typeof fallbackOrOptions === 'object' && fallbackOrOptions && 'session' in fallbackOrOptions
    ? `${key} ${(fallbackOrOptions as { session: string }).session}`
    : key
)) as TFunction;
const noop = () => {};

const lead: SessionWithProvider = {
  id: 'lead', summary: 'Use coagent to delegate', __provider: 'claude',
  childSessions: [
    {
      id: 'coder', provider: 'codex', summary: 'coder-42de9c', lastActivity: '2026-11-27T23:50:00Z',
      projectId: 'worktree', projectPath: '/workspace/acme-app-worktrees/coder', parentSessionId: 'lead',
    },
    {
      id: 'reviewer', provider: 'claude', summary: 'reviewer-c38d53', lastActivity: '2026-11-27T23:40:00Z',
      projectId: 'acme', projectPath: '/workspace/acme-app', parentSessionId: 'lead',
    },
  ],
};
const other: SessionWithProvider = { id: 'other', summary: 'Unrelated', __provider: 'claude' };

const props = (overrides: Partial<ComponentProps<typeof SidebarProjectSessions>> = {}): ComponentProps<typeof SidebarProjectSessions> => ({
  project: { projectId: 'acme', displayName: 'acme-app', fullPath: '/workspace/acme-app' },
  isExpanded: true, sessions: [lead, other], selectedSession: null, initialSessionsLoaded: true,
  hasMoreSessions: false, isLoadingMoreSessions: false,
  activeSessions: new Set(['coder']), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  currentTime: new Date('2026-11-28T00:00:00Z'), sessionRenameId: null, sessionRenameDraft: '',
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onProjectSelect: noop, onSessionSelect: noop, onArchiveSession: noop, onDeleteSession: noop,
  onForkSession: noop, onLoadMoreSessions: noop, onNewSession: noop, selectedSessionIds: null,
  onSetSessionSelection: noop, onToggleSessionSelected: noop, onCancelSessionSelection: noop,
  onDeleteSelectedSessions: noop, t, ...overrides,
});
const rowIds = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-session-id]')).map((row) => row.getAttribute('data-session-id'));

test.each([false, true])('children render under their parent with their own provider, state and link in compact=%s', (isCompact) => {
  compact.value = isCompact;
  const select = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ onSessionSelect: select })} />);

  assert.deepEqual(rowIds(container), ['lead', 'coder', 'reviewer', 'other']);
  const row = (id: string) => container.querySelector(`[data-session-id="${id}"]`)!;
  assert.equal(row('coder').getAttribute('data-child-session'), 'true');
  assert.equal(row('coder').getAttribute('data-parent-session-id'), 'lead');
  assert.equal(row('coder').getAttribute('data-fork-depth'), '1');
  assert.equal(row('lead').getAttribute('data-child-session'), null);

  const link = (id: string) => row(id).querySelector('[data-child-session-id]')!;
  assert.equal(link('coder').getAttribute('href'), '/session/coder');
  assert.equal(link('coder').getAttribute('data-child-session-state'), 'running');
  assert.ok(link('coder').querySelector('[data-child-session-running]'), 'a running child shows the spinner');
  assert.equal(link('reviewer').getAttribute('data-child-session-state'), 'idle');
  assert.match(link('reviewer').className, /opacity-60/, 'a finished child is muted');
  assert.doesNotMatch(link('coder').className, /opacity-60/);
  // Each row carries its own provider: the codex child shows the codex logo, not the parent's.
  assert.ok(link('coder').textContent?.includes('coder-42de9c'));
  assert.match(link('coder').getAttribute('title') ?? '', /Codex · \/workspace\/acme-app-worktrees\/coder/);

  fireEvent.click(screen.getByText('coder-42de9c'));
  assert.equal(select.mock.calls.length, 1);
  const [opened, projectId] = select.mock.calls[0];
  assert.equal(opened.id, 'coder');
  assert.equal(opened.__provider, 'codex');
  assert.equal(projectId, 'worktree', 'opening a child resolves its own project, not the listing one');

  // Modified clicks are left to the browser (new tab via href); jsdom cannot follow it.
  document.addEventListener('click', (event) => event.preventDefault(), { once: true });
  fireEvent.click(screen.getByText('reviewer-c38d53'), { metaKey: true });
  assert.equal(select.mock.calls.length, 1);
});

test('children collapse with their parent and are not offered for bulk selection', () => {
  compact.value = false;
  const setSelection = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ onSetSessionSelection: setSelection, activeSessions: new Set() })} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Use coagent to delegate' }));
  assert.deepEqual(rowIds(container), ['lead', 'other']);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.expandForks Use coagent to delegate' }));
  assert.deepEqual(rowIds(container), ['lead', 'coder', 'reviewer', 'other']);

  const { container: selecting } = render(<SidebarProjectSessions {...props({
    selectedSessionIds: new Set(), onSetSessionSelection: setSelection, activeSessions: new Set(),
  })} />);
  fireEvent.click(Array.from(selecting.querySelectorAll('button')).find((button) => button.textContent === 'sessions.selectAll')!);
  assert.deepEqual([...setSelection.mock.calls.at(-1)![0].sessionIds].sort(), ['lead', 'other']);
});

test('the selected child is highlighted and revealed under a collapsed parent', () => {
  compact.value = false;
  const { container } = render(<SidebarProjectSessions {...props({ selectedSession: { id: 'reviewer' } })} />);
  const link = container.querySelector('[data-child-session-id="reviewer"]')!;
  assert.equal(link.getAttribute('aria-current'), 'page');
  assert.doesNotMatch(link.className, /opacity-60/);
});

test.each([false, true])('opening a child asks the mobile drawer to close only in compact=%s', (isCompact) => {
  compact.value = isCompact;
  const select = vi.fn();
  render(<SidebarProjectSessions {...props({ onSessionSelect: select })} />);
  // `reviewer` runs in the listing project itself: the drawer would otherwise stay open.
  fireEvent.click(screen.getByText('reviewer-c38d53'));
  const [opened, projectId, options] = select.mock.calls[0];
  assert.equal(opened.id, 'reviewer');
  assert.equal(projectId, 'acme');
  assert.deepEqual(options, isCompact ? { closeSidebar: true } : undefined);
});

test('a child whose turn ended but whose background work still runs shows the background indicator, not an age', () => {
  compact.value = false;
  const { container } = render(<SidebarProjectSessions {...props({
    activeSessions: new Set(['reviewer']), backgroundSessionIds: new Set(['reviewer']),
  })} />);
  const link = container.querySelector('[data-child-session-id="reviewer"]')!;
  assert.equal(link.getAttribute('data-child-session-state'), 'running');
  assert.doesNotMatch(link.className, /opacity-60/);
  assert.equal(link.querySelector('[data-child-session-running]'), null, 'no spinner: no turn is in flight');
  assert.ok(link.querySelector('[data-child-session-background]'));
  assert.equal(within(link as HTMLElement).getByRole('status').getAttribute('aria-label'), 'tooltips.backgroundWorkIndicator');
  assert.ok(!link.textContent?.includes('20m'), 'the age is replaced by the indicator');
});
