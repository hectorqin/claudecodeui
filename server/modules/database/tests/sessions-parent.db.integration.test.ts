import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'sessions-parent-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const columnsOf = () => (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((column) => column.name);
const indexesOf = () => (getConnection().prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>).map((index) => index.name);

test('migration adds parent_session_id and its index to an existing sessions table, idempotently and without touching rows', async () => {
  await withDatabase(() => {
    const db = getConnection();
    sessionsDb.createAppSession('existing', 'claude', '/workspace/one', 'Existing');
    // Downgrade to the schema before the column existed.
    db.exec('DROP INDEX idx_sessions_parent_session_id');
    db.exec('ALTER TABLE sessions DROP COLUMN parent_session_id');
    assert.ok(!columnsOf().includes('parent_session_id'));

    runMigrations(db);
    assert.ok(columnsOf().includes('parent_session_id'));
    assert.ok(indexesOf().includes('idx_sessions_parent_session_id'));
    assert.equal(sessionsDb.getSessionById('existing')?.parent_session_id, null, 'nothing is backfilled');
    assert.equal(sessionsDb.getSessionById('existing')?.custom_name, 'Existing');

    sessionsDb.createAppSession('child', 'codex', '/workspace/two', 'Child', 'existing');
    runMigrations(db);
    assert.equal(sessionsDb.getSessionById('child')?.parent_session_id, 'existing', 'a rerun keeps stored parents');
  });
});

test('synchronizer upserts never clear a stored parent', async () => {
  await withDatabase(() => {
    sessionsDb.createAppSession('lead', 'claude', '/workspace/app', 'Lead');

    // App-created child, later announced and re-indexed from its transcript (UPDATE path).
    sessionsDb.createAppSession('child', 'codex', '/workspace/app-wt', 'Child', 'lead');
    sessionsDb.assignProviderSessionId('child', 'native-child');
    sessionsDb.createSession('native-child', 'codex', '/workspace/app-wt', 'Indexed name', undefined, '2099-01-01T00:00:00.000Z', '/t/child.jsonl');
    sessionsDb.createSession('native-child', 'codex', '/workspace/app-wt', 'Indexed again', undefined, '2099-01-02T00:00:00.000Z', '/t/child.jsonl');
    assert.equal(sessionsDb.getSessionById('child')?.parent_session_id, 'lead');

    // The watcher indexed the transcript first; merging the duplicate keeps the app row's parent.
    sessionsDb.createAppSession('raced', 'codex', '/workspace/app-wt', 'Raced', 'lead');
    sessionsDb.createSession('native-raced', 'codex', '/workspace/app-wt', 'Watcher row', undefined, undefined, '/t/raced.jsonl');
    sessionsDb.assignProviderSessionId('raced', 'native-raced');
    assert.equal(sessionsDb.getSessionById('raced')?.parent_session_id, 'lead');
    assert.equal(sessionsDb.getSessionById('native-raced'), null);

    // A row keyed by the provider id whose mapping is not recorded goes through ON CONFLICT.
    sessionsDb.createAppSession('legacy-native', 'claude', '/workspace/app-wt', 'Legacy', 'lead');
    sessionsDb.createSession('legacy-native', 'claude', '/workspace/app-wt', 'Legacy indexed', undefined, '2099-01-01T00:00:00.000Z');
    assert.equal(sessionsDb.getSessionById('legacy-native')?.parent_session_id, 'lead');
    assert.equal(sessionsDb.getSessionById('legacy-native')?.provider_session_id, 'legacy-native');
  });
});

test('attached children leave their project page and count; orphans return to it', async () => {
  await withDatabase(() => {
    sessionsDb.createAppSession('lead', 'claude', '/workspace/app', 'Lead');
    sessionsDb.createAppSession('own', 'codex', '/workspace/app-wt', 'Own session');
    sessionsDb.createAppSession('worker', 'codex', '/workspace/app-wt', 'Worker', 'lead');
    sessionsDb.createAppSession('dangling', 'codex', '/workspace/app-wt', 'Dangling', 'missing-parent');

    const pageIds = () => sessionsDb.getSessionsByProjectPathPage('/workspace/app-wt', 20, 0).map((row) => row.session_id).sort();
    assert.deepEqual(pageIds(), ['dangling', 'own']);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/app-wt'), 2);
    assert.equal(sessionsDb.countAttachedChildSessionsByProjectPath('/workspace/app-wt'), 1);
    assert.equal(sessionsDb.getAttachedParentId('worker'), 'lead');
    assert.equal(sessionsDb.getAttachedParentId('dangling'), null);
    assert.equal(sessionsDb.getAttachedParentId('own'), null);

    // Archiving the parent, or its project, detaches the child.
    sessionsDb.updateSessionIsArchived('lead', true);
    assert.deepEqual(pageIds(), ['dangling', 'own', 'worker']);
    assert.equal(sessionsDb.getAttachedParentId('worker'), null);
    sessionsDb.updateSessionIsArchived('lead', false);
    projectsDb.updateProjectIsArchived('/workspace/app', true);
    assert.equal(sessionsDb.getAttachedParentId('worker'), null);
    projectsDb.updateProjectIsArchived('/workspace/app', false);
    assert.equal(sessionsDb.getAttachedParentId('worker'), 'lead');
  });
});

test('child trees nest recursively in creation order, skip archived children and survive cycles', async () => {
  await withDatabase(() => {
    const db = getConnection();
    sessionsDb.createAppSession('lead', 'claude', '/workspace/app', 'Lead');
    sessionsDb.createAppSession('coder', 'codex', '/workspace/app-wt', 'Coder', 'lead');
    sessionsDb.createAppSession('reviewer', 'claude', '/workspace/app', 'Reviewer', 'lead');
    sessionsDb.createAppSession('helper', 'opencode', '/workspace/other', 'Helper', 'coder');
    sessionsDb.createAppSession('gone', 'claude', '/workspace/app', 'Gone', 'lead');
    sessionsDb.updateSessionIsArchived('gone', true);
    for (const [index, id] of ['lead', 'coder', 'reviewer', 'helper', 'gone'].entries()) {
      db.prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run(`2026-11-0${index + 1}T00:00:00.000Z`, id);
    }

    const tree = sessionsDb.getChildSessionsByParentIds(['lead', 'reviewer']);
    assert.deepEqual([...tree.keys()], ['lead'], 'parents without active children are absent');
    const children = tree.get('lead') ?? [];
    assert.deepEqual(children.map((child) => [child.id, child.provider, child.projectPath]), [
      ['coder', 'codex', '/workspace/app-wt'],
      ['reviewer', 'claude', '/workspace/app'],
    ]);
    assert.equal(children[0].parentSessionId, 'lead');
    assert.equal(children[0].summary, 'Coder');
    assert.ok(children[0].projectId);
    assert.deepEqual(children[0].childSessions.map((child) => [child.id, child.provider]), [['helper', 'opencode']]);

    // Damaged data: a parent loop terminates and lists each session once.
    db.prepare("UPDATE sessions SET parent_session_id = 'helper' WHERE session_id = 'lead'").run();
    const looped = sessionsDb.getChildSessionsByParentIds(['lead']).get('lead') ?? [];
    assert.deepEqual(looped.map((child) => child.id), ['coder', 'reviewer']);
    assert.deepEqual(looped[0].childSessions[0].childSessions, []);
  });
});
