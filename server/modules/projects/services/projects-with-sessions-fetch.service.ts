import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { ChildSessionSummary, RealtimeClientConnection, SessionForkAncestor } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { resolveWorktreeParent } from '@/modules/projects/services/project-worktree-parent.service.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  forkedFromSessionId: string | null;
  forkAncestors: SessionForkAncestor[];
  /**
   * The active session this one is nested under (see
   * `sessionsDb.getAttachedParentId`). Always null on an active project's
   * session page, which leaves such children out and lists them in their
   * parent's `childSessions` instead.
   */
  parentSessionId: string | null;
  /** Active sessions this one started, possibly in other projects and providers. */
  childSessions: ChildSessionSummary[];
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  forked_from_session_id?: string | null;
  parent_session_id?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  /** Main repository path when this project is a linked git worktree; the sidebar nests it there. */
  worktreeOf: string | null;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
  /**
   * Active sessions of this project that are listed under a parent session
   * instead of here. The sidebar hides a project that has these and no
   * sessions of its own.
   */
  childSessionCount: number;
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

type ProjectSessionRowsPage = {
  rows: SessionRepositoryRow[];
  total: number;
  hasMore: boolean;
};

/**
 * Maps page rows to summaries. `childSessions` is the child-tree map for
 * these rows, passed in when the caller already read it for a whole project
 * list; otherwise this reads it for these rows.
 */
function mapSessionRowsToSummaries(
  rows: SessionRepositoryRow[],
  childSessions: Map<string, ChildSessionSummary[]> = sessionsDb.getChildSessionsByParentIds(rows.map((row) => row.session_id)),
): SessionSummary[] {
  return rows.map((row) => ({
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    forkedFromSessionId: row.forked_from_session_id ?? null,
    forkAncestors: row.forked_from_session_id ? sessionsDb.getForkAncestors(row.session_id) : [],
    parentSessionId: row.parent_session_id ? sessionsDb.getAttachedParentId(row.session_id) : null,
    childSessions: childSessions.get(row.session_id) ?? [],
  }));
}

function readProjectSessionRowsIncludingArchived(projectPath: string): ProjectSessionRowsPage {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];
  return { rows, total: rows.length, hasMore: false };
}

/**
 * Turns every project's page rows into summaries with one child-tree read
 * for the whole list, so its cost does not grow with the number of projects.
 */
function mapProjectPagesToSummaries(pages: ProjectSessionRowsPage[]): SessionSummary[][] {
  const childSessions = sessionsDb.getChildSessionsByParentIds(pages.flatMap((page) => page.rows.map((row) => row.session_id)));
  return pages.map((page) => mapSessionRowsToSummaries(page.rows, childSessions));
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionRowsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionRowsPage {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    rows,
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const page = readProjectSessionRowsPageByPath(projectPath, options);
  return { sessions: mapSessionRowsToSummaries(page.rows), total: page.total, hasMore: page.hasMore };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const knownProjectPaths = new Set(projectRows.map((row) => row.project_path));
  const projects: Array<Omit<ProjectListItem, 'sessions' | 'childSessionCount'>> = [];
  const pages: ProjectSessionRowsPage[] = [];
  let processedProjects = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionRowsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });
    pages.push(sessionsPage);

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      worktreeOf: resolveWorktreeParent(projectPath, knownProjectPaths),
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  // Child trees and attached-child counts for every project at once.
  const sessionsByProject = mapProjectPagesToSummaries(pages);
  const childSessionCounts = sessionsDb.countAttachedChildSessionsByProjectPaths(projects.map((project) => project.path));

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects.map((project, index) => ({
    ...project,
    sessions: sessionsByProject[index],
    childSessionCount: childSessionCounts.get(project.path) ?? 0,
  }));
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: Array<Omit<ArchivedProjectListItem, 'sessions'>> = [];
  const pages: ProjectSessionRowsPage[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionRowsIncludingArchived(row.project_path);
    pages.push(sessionsPage);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      worktreeOf: null,
      isArchived: true,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
      // An archived project lists every session it holds, children included.
      childSessionCount: 0,
    });
  }

  const sessionsByProject = mapProjectPagesToSummaries(pages);
  return archivedProjects.map((project, index) => ({ ...project, sessions: sessionsByProject[index] }));
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
