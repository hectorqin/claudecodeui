import type { ChildSessionSummary, SessionWithProvider } from '@/shared/types';

type TreeNode = {
  session: SessionWithProvider;
  parentId: string | null;
  children: TreeNode[];
  rank: number;
  pinRank: number;
  isChildSession: boolean;
};

export type ProjectSessionTreeRow = {
  session: SessionWithProvider;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  isLastSibling: boolean;
  /**
   * The row is a child session: started by the row it hangs under, and
   * possibly in another project and on another provider. Rendered read-only,
   * opened by navigating to it.
   */
  isChildSession: boolean;
};

/** A server child summary as a sidebar session, tagged with its own project so opening it resolves the right workspace. */
export function childSessionToSession(child: ChildSessionSummary): SessionWithProvider {
  return {
    id: child.id,
    summary: child.summary,
    lastActivity: child.lastActivity,
    createdAt: child.createdAt,
    provider: child.provider,
    __provider: child.provider,
    __projectId: child.projectId ?? undefined,
    projectPath: child.projectPath,
    parentSessionId: child.parentSessionId,
    forkedFromSessionId: child.forkedFromSessionId ?? null,
    childSessions: child.childSessions ?? [],
  };
}

/**
 * SidebarProjectSessions alone uses this projection. Keep the shared session
 * list flat so Conversations, search and pagination retain their own ordering.
 * The input is newest first; a family's newest descendant determines its
 * position, and parents always precede children. Ancestor hints fill page gaps,
 * while actual page rows take precedence over their older context snapshots.
 * A pin lifts its entire family; only root ordering changes, never ancestry.
 *
 * Child sessions (`childSessions`, started by a row) are emitted under that
 * row after its forks, in the order they were started. Precedence when a
 * session has both kinds of parent: a session with an attached child-parent
 * (`parentSessionId`) is shown only under that parent, so it is dropped from
 * the input here; fork nesting still applies within each sibling group, which
 * is how a fork of a child (it inherits the child's parent) nests under its
 * source among that parent's children.
 */
export function buildProjectSessionTree(
  sessions: SessionWithProvider[],
  projectId: string,
  pinnedIds: readonly string[] = [],
): ProjectSessionTreeRow[] {
  const roots = buildForkForest(sessions.filter((session) => !session.parentSessionId), projectId, pinnedIds);

  const rows: ProjectSessionTreeRow[] = [];
  // Each session is emitted once, even when damaged data repeats it.
  const emitted = new Set<string>();
  type Frame = { node: TreeNode; depth: number; isLastSibling: boolean; parentId: string | null };
  const childrenOf = (node: TreeNode): TreeNode[] => {
    const childSessions = (node.session.childSessions ?? [])
      .map(childSessionToSession)
      .filter((child) => !emitted.has(child.id));
    const childForest = childSessions.length
      ? buildForkForest(childSessions, projectId, [], true)
      : [];
    return [...node.children, ...childForest];
  };
  const stack: Frame[] = roots.map((node, index) => ({ node, depth: 0, isLastSibling: index === roots.length - 1, parentId: null })).reverse();
  while (stack.length) {
    const { node, depth, isLastSibling, parentId } = stack.pop()!;
    if (emitted.has(node.session.id)) continue;
    emitted.add(node.session.id);
    const children = childrenOf(node);
    rows.push({ session: node.session, parentId, depth, hasChildren: children.length > 0, isLastSibling, isChildSession: node.isChildSession });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], depth: depth + 1, isLastSibling: index === children.length - 1, parentId: node.session.id });
    }
  }
  return rows;
}

function buildForkForest(
  sessions: SessionWithProvider[],
  projectId: string,
  pinnedIds: readonly string[],
  isChildSession = false,
): TreeNode[] {
  const pinRanks = new Map(pinnedIds.map((id, rank) => [id, rank]));
  const nodes = new Map<string, TreeNode>();
  sessions.forEach((session, rank) => {
    if (!nodes.has(session.id)) {
      nodes.set(session.id, { session, parentId: null, children: [], rank, pinRank: pinRanks.get(session.id) ?? Infinity, isChildSession });
    }
  });

  const hints = new Map<string, NonNullable<SessionWithProvider['forkAncestors']>[number]>();
  // Newest sessions arrive first; keep their current ancestor snapshots when
  // older siblings still carry an earlier title or activity timestamp.
  for (const session of sessions) {
    for (const ancestor of session.forkAncestors ?? []) {
      if (!hints.has(ancestor.id)) hints.set(ancestor.id, ancestor);
    }
  }
  for (const session of sessions) {
    let child = session;
    const visited = new Set([child.id]);
    while (child.forkedFromSessionId && !visited.has(child.forkedFromSessionId)) {
      const parentId = child.forkedFromSessionId;
      visited.add(parentId);
      const existing = nodes.get(parentId);
      // Existing nodes already have their own ancestry pass. In particular,
      // walking every loaded chain again would make deep trees quadratic.
      if (existing) break;
      const hint = hints.get(parentId);
      const parent = hint ? {
        ...hint,
        __provider: hint.__provider ?? hint.provider ?? session.__provider,
        __projectId: projectId,
      } : null;
      if (!parent || parent.__provider !== session.__provider) break;
      nodes.set(parentId, { session: parent, parentId: null, children: [], rank: Infinity, pinRank: pinRanks.get(parentId) ?? Infinity, isChildSession });
      child = parent;
    }
  }

  for (const node of nodes.values()) {
    const parent = nodes.get(node.session.forkedFromSessionId ?? '');
    if (parent && parent !== node && parent.session.__provider === node.session.__provider) {
      node.parentId = parent.session.id;
    }
  }

  // Sever one edge per cycle, without recursion or dropping any session.
  const checked = new Set<string>();
  for (const node of nodes.values()) {
    const path = new Set<string>();
    let current: TreeNode | undefined = node;
    while (current && !checked.has(current.session.id)) {
      path.add(current.session.id);
      if (current.parentId && path.has(current.parentId)) {
        current.parentId = null;
        break;
      }
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    for (const id of path) checked.add(id);
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Post-order gives each family its newest member and newest pin ranks.
  const pending = [...roots];
  const traversal: TreeNode[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    traversal.push(node);
    pending.push(...node.children);
  }
  for (let index = traversal.length - 1; index >= 0; index -= 1) {
    const node = traversal[index];
    if (node.parentId) {
      const parent = nodes.get(node.parentId)!;
      parent.rank = Math.min(parent.rank, node.rank);
      parent.pinRank = Math.min(parent.pinRank, node.pinRank);
    }
    node.children.sort((a, b) => a.rank - b.rank);
  }
  roots.sort((a, b) => {
    if (a.pinRank !== b.pinRank) return a.pinRank - b.pinRank;
    return a.rank - b.rank;
  });

  return roots;
}
