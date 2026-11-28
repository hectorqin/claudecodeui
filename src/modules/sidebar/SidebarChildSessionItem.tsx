import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { LLMProviderLogo, Tooltip, buttonVariants } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ProjectSession, SessionWithProvider } from '@/shared/types';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { PROVIDER_LABELS, createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';

type SidebarChildSessionItemProps = {
  /** A child summary converted by `childSessionToSession`: tagged with its own provider and project. */
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  /** A turn is in flight. */
  isProcessing: boolean;
  /** The turn ended but work it launched still runs. */
  hasBackgroundWork: boolean;
  currentTime: Date;
  /** Opens the session; the second argument is the projectId the session belongs to, which may not be the listing project. */
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  t: TFunction;
};

/**
 * One child session under the session that started it, rendered by
 * SidebarProjectSessions. Children often run in another project and on
 * another provider, so the row shows its own provider and is read-only here:
 * it only opens the session (renaming, archiving and the rest happen once it
 * is open). A child with no work in progress is muted, so finished workers
 * read as done.
 */
function SidebarChildSessionItem({
  session,
  selectedSession,
  isProcessing,
  hasBackgroundWork,
  currentTime,
  onSessionSelect,
  t,
}: SidebarChildSessionItemProps) {
  const isCompact = useCompactSidebar();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isRunning = isProcessing || hasBackgroundWork;
  const age = formatCompactAge(sessionView.sessionTime, currentTime);
  const projectPath = typeof session.projectPath === 'string' ? session.projectPath : '';
  const providerLabel = PROVIDER_LABELS[session.__provider] ?? session.__provider;

  return (
    <a
      href={`/session/${session.id}`}
      data-child-session-id={session.id}
      data-child-session-state={isRunning ? 'running' : 'idle'}
      aria-current={isSelected ? 'page' : undefined}
      title={projectPath ? `${sessionView.sessionName}\n${providerLabel} · ${projectPath}` : `${sessionView.sessionName}\n${providerLabel}`}
      className={cn(
        buttonVariants({ variant: 'ghost' }),
        'h-auto w-full justify-start rounded-md border border-transparent bg-transparent px-1.5 text-left font-normal transition-colors duration-150',
        isCompact ? 'min-h-10 py-2' : 'py-1',
        isSelected ? 'border-primary/20 bg-primary/5' : 'hover:bg-accent/50',
        !isRunning && !isSelected && 'opacity-60 hover:opacity-100',
      )}
      // Left-click keeps in-app navigation; modified clicks use the href.
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSessionSelect(session, session.__projectId ?? '');
      }}
    >
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <div
          className={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md',
            isSelected ? 'bg-primary/10' : 'bg-muted/50',
          )}
        >
          <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />
        </div>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            isRunning ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {sessionView.sessionName}
        </span>
        {isProcessing ? (
          <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground" data-child-session-running="">
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          </Tooltip>
        ) : age ? (
          <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{age}</span>
        ) : null}
      </div>
    </a>
  );
}

export default memo(SidebarChildSessionItem);
