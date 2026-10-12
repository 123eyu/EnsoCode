import type { BotProfile, DelegationTrigger, GroupTaskRun } from '@shared/types/bot';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { formatElapsed, isActiveDelegation } from '@/stores/bots/delegations';
import { taskRunRows } from '@/stores/bots/groupBoard';
import { BotAvatar } from './BotAvatar';
import { DelegationBadge, failureText, useNow } from './DelegationCard';

/** 默认只显示最近几次执行 */
const RECENT_RUNS = 5;

export function triggerText(trigger: DelegationTrigger, t: TFunction): string {
  switch (trigger) {
    case 'append':
      return t('Appended');
    case 'reply':
      return t('Resumed after reply');
    case 'rework':
      return t('Rework');
    case 'retry':
      return t('Retry');
    default:
      return t('Delegated');
  }
}

/** 任务卡「历次执行」：执行人、来源、状态、耗时、失败原因；转派缩进；查看过程按状态分流由上层处理 */
export function TaskRuns({
  runs,
  bots,
  onOpenConversation,
}: {
  runs: readonly GroupTaskRun[];
  bots: Map<string, BotProfile>;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  const delegations = useBotsStore((s) => s.delegations);
  const now = useNow(runs.some((run) => isActiveDelegation(run.state)));
  const [all, setAll] = useState(false);
  const rows = taskRunRows(runs, delegations, now);
  const shown = all ? rows : rows.slice(-RECENT_RUNS);
  const nameOf = (id: string) => bots.get(id)?.name ?? t('Deleted member');
  return (
    <section className="mt-1.5 border-t pt-1.5">
      <h5 className="mb-1 text-[11px] text-muted-foreground">
        {t('Run history')} · {rows.length}
      </h5>
      <ul className="space-y-1">
        {shown.map(({ run, record, time }) => {
          const failure = run.state === 'failed' ? failureText(record ?? run, t) : undefined;
          return (
            <li key={run.id} className={cn(run.nested && 'ml-3 border-l pl-2')}>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
                <BotAvatar bot={bots.get(run.botId)} size="xs" />
                <span className="text-foreground">{nameOf(run.botId)}</span>
                <span>· {run.nested ? t('Sub-delegation') : triggerText(run.trigger, t)}</span>
                {time.queued ? (
                  <span className="rounded bg-info/15 px-1.5 text-[11px] text-info">
                    {t('Queued {{time}}', { time: formatElapsed(time.ms) })}
                  </span>
                ) : (
                  <>
                    <DelegationBadge
                      state={run.state}
                      interrupted={run.failure === 'interrupted'}
                    />
                    <span>{formatElapsed(time.ms)}</span>
                  </>
                )}
                <span className="flex-1" />
                {record && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      onOpenConversation(
                        record.childConversationId,
                        t('{{from}} → {{to}} · Delegation', {
                          from: nameOf(record.parentBotId),
                          to: nameOf(record.targetBotId),
                        })
                      )
                    }
                  >
                    {t('View process')}
                  </Button>
                )}
              </div>
              {failure && (
                <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-destructive">
                  {failure}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length && (
        <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
          {t('Show all ({{n}})', { n: rows.length })}
        </Button>
      )}
    </section>
  );
}
