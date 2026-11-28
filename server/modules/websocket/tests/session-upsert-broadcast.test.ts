import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
  buildSessionUpsertedEvent,
} from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an upsert always carries the provider session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-1');

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'app-1');
    assert.equal(connection.frames[0].providerSessionId, 'native-1');
  });
});

test('the watcher path resolves a provider-native id to the same canonical event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-2', 'native-2');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The sessions watcher only ever knows the id written in the transcript.
    await broadcastSessionUpsertedBatch(['native-2']);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].providerSessionId, 'native-2');
  });
});

test('a session with no provider id yet reports null rather than omitting the field', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-3');

    assert.equal(connection.frames.length, 1);
    assert.ok('providerSessionId' in connection.frames[0]);
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('a fork broadcast carries its app-facing parent and off-page ancestors for immediate nesting', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('parent', 'claude', '/workspace/demo', 'Original');
    sessionsDb.assignProviderSessionId('parent', 'native-parent');
    sessionsDb.createForkedSession({
      sessionId: 'child', provider: 'claude', projectPath: '/workspace/demo',
      customName: 'Fork', providerSessionId: 'native-child', jsonlPath: '/transcripts/child.jsonl',
      forkedFromSessionId: 'parent', model: null, effort: null,
    });
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('child');
    await broadcastSessionUpsertedBatch(['native-child']);
    const summary = connection.frames[0].session as { forkedFromSessionId: string; forkAncestors: { id: string }[] };
    assert.equal(summary.forkedFromSessionId, 'parent');
    assert.deepEqual(summary.forkAncestors.map((ancestor) => ancestor.id), ['parent']);
    assert.deepEqual(connection.frames[1].session, summary);
  });
});

test('an unresolvable id broadcasts nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('does-not-exist');
    await broadcastSessionUpsertedBatch(['also-missing']);

    assert.deepEqual(connection.frames, []);
  });
});

test('a batch delivers every resolvable session and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch(['app-4', 'missing', 'app-5']);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-4', 'app-5'],
    );
  });
});

test('a closed socket is skipped', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-6', 'claude', '/workspace/demo');

    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 3;
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    await broadcastSessionUpserted('app-6');

    assert.equal(open.frames.length, 1);
    assert.deepEqual(closing.frames, []);
  });
});

test('session_upserted carries the attached parent for a child and the children for a parent', async () => {
  await withIsolatedDatabase(async () => {
    sessionsService.createAppSession('claude', '/workspace/acme-app', 'Use coagent to delegate');
    const lead = sessionsDb.getSessionsByProjectPath('/workspace/acme-app')[0].session_id;
    const coder = sessionsService.createAppSession('codex', '/workspace/acme-app-worktrees/coder', 'coder task', { parentSessionId: lead }).sessionId;
    const reviewer = sessionsService.createAppSession('claude', '/workspace/acme-app', 'reviewer task', { parentSessionId: lead }).sessionId;
    getConnection().prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run('2026-11-21T00:00:00.000Z', coder);
    getConnection().prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run('2026-11-22T00:00:00.000Z', reviewer);

    const childEvent = await buildSessionUpsertedEvent(coder);
    assert.equal(childEvent?.session.parentSessionId, lead);
    assert.deepEqual(childEvent?.session.childSessions, []);
    assert.equal(childEvent?.provider, 'codex');
    assert.equal(childEvent?.project?.path, '/workspace/acme-app-worktrees/coder', 'the child keeps naming the project it runs in');

    const parentEvent = await buildSessionUpsertedEvent(lead);
    assert.equal(parentEvent?.session.parentSessionId, null);
    assert.deepEqual(parentEvent?.session.childSessions?.map((child) => child.id), [coder, reviewer]);

    sessionsDb.updateSessionIsArchived(lead, true);
    assert.equal((await buildSessionUpsertedEvent(coder))?.session.parentSessionId, null);
  });
});
