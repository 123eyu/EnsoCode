import type { BotChat, BotProfile, Delegation, GroupTask } from '@shared/types/bot';
import {
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  stalledTaskRun,
  TASK_CHECK_TEXT_MAX,
  taskBlock,
} from '@shared/types/bot';
import {
  Check,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  UserPlus,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/ui/menu';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { isRetried } from '@/stores/bots/delegations';
import { canRework, chatDelegationGroups, taskColumns } from '@/stores/bots/groupBoard';
import { BotAvatar } from './BotAvatar';
import { FieldLabel } from './BotFields';
import { CheckBadge, DelegationCard, failureText, retryDelegation } from './DelegationCard';
import { TaskRuns } from './TaskRuns';

/** 已完成 / 已取消 / 终态委派默认只显示最近几条 */
const RECENT = 5;

const stamp = (at: number) =>
  new Date(at).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function taskErrorText(error: string, t: TFunction): string {
  switch (error) {
    case 'invalid':
      return t('Check the title and details.');
    case 'disabled':
      return t('Bot mode is off.');
    default:
      return error;
  }
}

function Group({
  title,
  count,
  limit,
  children,
}: {
  title: string;
  count: number;
  limit?: number;
  children: (shown: number) => React.ReactNode;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const shown = limit && !all ? Math.min(limit, count) : count;
  return (
    <section className="mt-4 first:mt-0">
      <h4 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {title} · {count}
      </h4>
      <div className="space-y-1.5">{children(shown)}</div>
      {count > shown && (
        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setAll(true)}>
          {t('Show all ({{n}})', { n: count })}
        </Button>
      )}
    </section>
  );
}

/** 群任务看板：按状态分组；新建、编辑、指派（以人类身份 @ 成员）、完成、验收、取消、删除 */
export function TaskBoard({
  chat,
  onOpenConversation,
}: {
  chat: BotChat;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  const tasks = useBotsStore((s) => s.tasks[chat.id]);
  const bots = useBotsStore((s) => s.bots);
  const delegations = useBotsStore((s) => s.delegations);
  const [editing, setEditing] = useState<GroupTask | 'new' | null>(null);
  const [deleting, setDeleting] = useState<GroupTask | null>(null);
  const [returning, setReturning] = useState<{ task: GroupTask; rework: boolean } | null>(null);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const members = chat.members.flatMap((id) => {
    const bot = byId.get(id);
    return bot && bot.archivedAt === undefined ? [bot] : [];
  });

  useEffect(() => {
    void useBotsStore.getState().refreshTasks(chat.id);
  }, [chat.id]);

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>, failed: string) => {
    const result = await action();
    if (!result.ok)
      addToast({ type: 'error', title: failed, description: taskErrorText(result.error ?? '', t) });
    void useBotsStore.getState().refreshTasks(chat.id);
  };
  const api = window.electronAPI.bots.tasks;
  const ref = (task: GroupTask) => ({ chatId: chat.id, id: task.id });

  if (!tasks) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const columns = taskColumns(tasks);
  const card = (task: GroupTask) => (
    <TaskCard
      key={task.id}
      task={task}
      bots={byId}
      members={members}
      onOpenConversation={onOpenConversation}
      failed={delegations.find((record) => record.id === task.delegationId)}
      onEdit={() => setEditing(task)}
      onAssign={(botId) =>
        void run(() => api.assign({ ...ref(task), botId }), t('Task not assigned'))
      }
      onComplete={() => void run(() => api.complete(ref(task)), t('Task not updated'))}
      onAccept={() =>
        void run(() => api.review({ ...ref(task), accept: true }), t('Task not updated'))
      }
      onReturn={(rework) => setReturning({ task, rework })}
      onCancel={() => void run(() => api.cancel(ref(task)), t('Task not updated'))}
      onDelete={() => setDeleting(task)}
      onReply={(text) =>
        api.reply({ ...ref(task), text }).then((result) => {
          void useBotsStore.getState().refreshTasks(chat.id);
          if (!result.ok)
            addToast({
              type: 'error',
              title: t('Reply not sent'),
              description: taskErrorText(result.error, t),
            });
          return result.ok;
        })
      }
    />
  );
  return (
    <div>
      <Button size="xs" variant="outline" className="mb-3" onClick={() => setEditing('new')}>
        <Plus />
        {t('New task')}
      </Button>
      {tasks.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t('No tasks yet. Members can also add and claim tasks with the board tool.')}
        </p>
      )}
      {columns.todo.length > 0 && (
        <Group title={t('To do')} count={columns.todo.length}>
          {() => columns.todo.map(card)}
        </Group>
      )}
      {columns.doing.length > 0 && (
        <Group title={t('Doing')} count={columns.doing.length}>
          {() => columns.doing.map(card)}
        </Group>
      )}
      {columns.blocked.length > 0 && (
        <Group title={t('Stuck tasks')} count={columns.blocked.length}>
          {() => columns.blocked.map(card)}
        </Group>
      )}
      {columns.review.length > 0 && (
        <Group title={t('Awaiting review')} count={columns.review.length}>
          {() => columns.review.map(card)}
        </Group>
      )}
      {columns.done.length > 0 && (
        <Group title={t('Completed')} count={columns.done.length} limit={RECENT}>
          {(shown) => columns.done.slice(0, shown).map(card)}
        </Group>
      )}
      {columns.canceled.length > 0 && (
        <Group title={t('Canceled')} count={columns.canceled.length} limit={0}>
          {(shown) => columns.canceled.slice(0, shown).map(card)}
        </Group>
      )}
      {editing && (
        <TaskEditor
          chatId={chat.id}
          task={editing === 'new' ? undefined : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void useBotsStore.getState().refreshTasks(chat.id);
          }}
        />
      )}
      {returning && (
        <ReturnDialog
          task={returning.task}
          assignee={byId.get(returning.task.assigneeBotId ?? '')?.name ?? t('Deleted member')}
          rework={returning.rework}
          onClose={() => setReturning(null)}
          onReturn={(reason) =>
            api
              .review({
                ...ref(returning.task),
                accept: false,
                reason,
                ...(returning.rework ? { rework: true } : {}),
              })
              .then((result) => {
                if (result.ok) {
                  setReturning(null);
                  void useBotsStore.getState().refreshTasks(chat.id);
                }
                return result.ok ? null : taskErrorText(result.error, t);
              })
          }
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete task #{{n}}?', { n: deleting?.seq ?? '' })}
        description={t('The task is removed from the board. This cannot be undone.')}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          const task = deleting;
          setDeleting(null);
          if (task) void run(() => api.remove(ref(task)), t('Task not deleted'));
        }}
      />
    </div>
  );
}

function TaskCard({
  task,
  bots,
  members,
  onOpenConversation,
  onEdit,
  onAssign,
  onComplete,
  onAccept,
  onReturn,
  onCancel,
  onDelete,
  onReply,
  failed,
}: {
  task: GroupTask;
  bots: Map<string, BotProfile>;
  members: BotProfile[];
  onOpenConversation: (conversationId: string, title: string) => void;
  /** 任务当前挂的委派记录（执行失败时显示原因） */
  failed?: Delegation;
  onEdit: () => void;
  onAssign: (botId: string) => void;
  onComplete: () => void;
  onAccept: () => void;
  /** rework：原执行人在原会话返工；否则退回待办 */
  onReturn: (rework: boolean) => void;
  onCancel: () => void;
  onDelete: () => void;
  /** 任务卡回复框：缺信息卡住时解除，执行中插入当前执行，其他状态记评论 */
  onReply: (text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const open = task.status === 'todo' || task.status === 'doing' || task.status === 'blocked';
  const review = task.status === 'review';
  // 执行失败：仍由执行人负责，只能重试、改派或取消
  const stalled = stalledTaskRun(task);
  const block = taskBlock(task);
  const assignee = task.assigneeBotId ? bots.get(task.assigneeBotId) : undefined;
  const creator =
    task.createdBy === 'human' ? t('You') : (bots.get(task.createdBy)?.name ?? t('Deleted member'));
  return (
    <div
      data-slot="bot-card"
      className={cn(
        'group rounded-lg border bg-card px-2.5 py-2 text-xs',
        !open && !review && 'opacity-75'
      )}
    >
      <div className="flex items-start gap-1.5">
        <span className="shrink-0 text-muted-foreground">#{task.seq}</span>
        <span className="min-w-0 flex-1 break-words font-medium text-sm">{task.title}</span>
        <Menu>
          <MenuTrigger className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100 data-popup-open:opacity-100">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>
              <Pencil />
              {t('Edit')}
            </MenuItem>
            {open &&
              (!task.delegationId || task.status === 'blocked' || stalled) &&
              members.length > 0 && (
                <MenuSub>
                  <MenuSubTrigger>
                    <UserPlus />
                    {stalled ? t('Reassign to') : t('Assign to')}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    {members.map((bot) => (
                      <MenuItem
                        key={bot.id}
                        disabled={bot.id === task.assigneeBotId}
                        onClick={() => onAssign(bot.id)}
                      >
                        <BotAvatar bot={bot} size="xs" />
                        {bot.name}
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              )}
            {open && !stalled && (
              <MenuItem onClick={onComplete}>
                <Check />
                {t('Mark done')}
              </MenuItem>
            )}
            {(open || review) && (
              <MenuItem onClick={onCancel}>
                <X />
                {t('Cancel task')}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {t('Delete')}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {task.detail && (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
          {task.detail}
        </div>
      )}
      {task.result && (
        <div
          className={cn(
            'mt-1 rounded px-1.5 py-1 text-foreground',
            task.status !== 'done' && task.check?.passed === false
              ? 'bg-destructive/10'
              : 'bg-success/10'
          )}
        >
          <div className="line-clamp-3 whitespace-pre-wrap">{task.result}</div>
        </div>
      )}
      {task.returnReason && (
        <div className="mt-1 rounded bg-warning/10 px-1.5 py-1 text-foreground">
          <div className="line-clamp-3 whitespace-pre-wrap">
            {t('Returned: {{reason}}', { reason: task.returnReason })}
          </div>
        </div>
      )}
      {stalled && (
        <div className="mt-1 rounded bg-destructive/10 px-1.5 py-1 text-foreground">
          <div className="line-clamp-3 whitespace-pre-wrap">
            {t('Blocked · run failed: {{reason}}', {
              reason: (failed?.state === 'failed' && failureText(failed, t)) || t('Failed'),
            })}
          </div>
          <Button
            size="xs"
            variant="outline"
            className="mt-1"
            onClick={() => retryDelegation(stalled.id, t)}
          >
            <RotateCcw />
            {t('Retry')}
          </Button>
        </div>
      )}
      {block?.reason === 'need' && (
        <div className="mt-1 rounded bg-warning/10 px-1.5 py-1 text-foreground">
          <div className="line-clamp-3 whitespace-pre-wrap">
            {t('Blocked · needs: {{need}}', { need: block.need })}
          </div>
        </div>
      )}
      {(block?.reason === 'need' || review || (task.status === 'doing' && task.delegationId)) && (
        <TaskReply
          placeholder={
            block?.reason === 'need'
              ? t('Answer {{name}}…', { name: assignee?.name ?? t('Deleted member') })
              : task.status === 'doing' && task.delegationId
                ? t('Add to the current run…')
                : t('Comment…')
          }
          onSend={onReply}
        />
      )}
      {task.check && <CheckBadge check={task.check} className="mt-1" />}
      {review && (
        <div className="mt-1.5 flex gap-1.5">
          <Button size="xs" onClick={onAccept}>
            <Check />
            {t('Accept result')}
          </Button>
          <Button size="xs" variant="outline" onClick={() => onReturn(false)}>
            <Undo2 />
            {t('Return')}
          </Button>
          {canRework(task) && (
            <Button size="xs" variant="outline" onClick={() => onReturn(true)}>
              <Wrench />
              {t('Return for rework')}
            </Button>
          )}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
        {assignee || task.assigneeBotId ? (
          <span className="flex items-center gap-1">
            <BotAvatar bot={assignee} size="xs" />
            {assignee?.name ?? t('Deleted member')}
          </span>
        ) : (
          <span>{t('Unassigned')}</span>
        )}
        {task.delegationId && <span>· {t('Delegation')}</span>}
        <span className="flex-1" />
        <span title={t('Created by {{name}}', { name: creator })}>{stamp(task.updatedAt)}</span>
      </div>
      {task.runs && task.runs.length > 0 && (
        <TaskRuns runs={task.runs} bots={bots} onOpenConversation={onOpenConversation} />
      )}
    </div>
  );
}

/** 任务卡回复框（最小可用版） */
function TaskReply({
  placeholder,
  onSend,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    if (await onSend(value)) setText('');
    setSending(false);
  };
  return (
    <div className="mt-1 flex items-end gap-1">
      <Textarea
        value={text}
        rows={1}
        maxLength={GROUP_TASK_TEXT_MAX}
        placeholder={placeholder}
        className="min-h-0 text-xs"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('Send reply')}
        disabled={!text.trim() || sending}
        onClick={() => void send()}
      >
        <Send />
      </Button>
    </div>
  );
}

/** 验收退回：必须写原因；rework 时原执行人带着原因在原会话返工 */
function ReturnDialog({
  task,
  assignee,
  rework,
  onClose,
  onReturn,
}: {
  task: GroupTask;
  assignee: string;
  rework: boolean;
  onClose: () => void;
  /** 返回错误文案，成功返回 null */
  onReturn: (reason: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) return setError(t('Enter a reason.'));
    setBusy(true);
    try {
      setError(await onReturn(reason.trim()));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {rework
              ? t('Return task #{{n}} for rework', { n: task.seq })
              : t('Return task #{{n}}', { n: task.seq })}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <FieldLabel>{t('Reason for returning')}</FieldLabel>
          <Textarea
            rows={4}
            autoFocus
            value={reason}
            maxLength={GROUP_TASK_TEXT_MAX}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {rework
              ? t(
                  '{{name}} continues in the same conversation with this reason, and the result comes back for review.',
                  { name: assignee }
                )
              : t('The task goes back to To do with this reason and can be reassigned.')}
          </p>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {rework ? t('Return for rework') : t('Return')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskEditor({
  chatId,
  task,
  onClose,
}: {
  chatId: string;
  task?: GroupTask;
  onClose: (saved: boolean) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(task?.title ?? '');
  const [detail, setDetail] = useState(task?.detail ?? '');
  const [check, setCheck] = useState(task?.check?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim()) return setError(t('Enter a title.'));
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.tasks.save({
        chatId,
        title: title.trim(),
        detail: detail.trim(),
        check: check.trim(),
        ...(task ? { id: task.id } : {}),
      });
      if (result.ok) onClose(true);
      else setError(taskErrorText(result.error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{task ? t('Edit task #{{n}}', { n: task.seq }) : t('New task')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div>
            <FieldLabel>{t('Task title')}</FieldLabel>
            <Input
              value={title}
              maxLength={GROUP_TASK_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div>
            <FieldLabel>{t('Details')}</FieldLabel>
            <Textarea
              rows={4}
              value={detail}
              maxLength={GROUP_TASK_TEXT_MAX}
              onChange={(event) => setDetail(event.target.value)}
            />
          </div>
          <div>
            <FieldLabel>{t('Acceptance check (optional)')}</FieldLabel>
            <Input
              value={check}
              maxLength={TASK_CHECK_TEXT_MAX}
              onChange={(event) => setCheck(event.target.value)}
            />
            <p className="mt-1 text-muted-foreground text-xs">
              {t(
                "Done only when the member's tool output contains this text, e.g. a command printing ALL_TESTS_PASS."
              )}
            </p>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onClose(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 本群委派汇总：进行中 / 已完成 / 失败·中断·取消；复用委派卡片的取消、重试、查看过程 */
export function GroupDelegations({
  chat,
  onOpenConversation,
}: {
  chat: BotChat;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  const delegations = useBotsStore((s) => s.delegations);
  const bots = useBotsStore((s) => s.bots);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const groups = useMemo(() => chatDelegationGroups(delegations, chat.id), [delegations, chat.id]);
  const card = (record: Delegation) => (
    <DelegationCard
      key={record.id}
      record={record}
      retried={isRetried(record, delegations)}
      bots={byId}
      onOpenConversation={onOpenConversation}
    />
  );
  if (!groups.active.length && !groups.completed.length && !groups.failed.length)
    return <p className="text-muted-foreground text-xs">{t('No delegations in this group yet')}</p>;
  return (
    <div>
      {groups.active.length > 0 && (
        <Group title={t('In progress')} count={groups.active.length}>
          {() => groups.active.map(card)}
        </Group>
      )}
      {groups.completed.length > 0 && (
        <Group title={t('Completed')} count={groups.completed.length} limit={RECENT}>
          {(shown) => groups.completed.slice(0, shown).map(card)}
        </Group>
      )}
      {groups.failed.length > 0 && (
        <Group
          title={t('Failed · interrupted · canceled')}
          count={groups.failed.length}
          limit={RECENT}
        >
          {(shown) => groups.failed.slice(0, shown).map(card)}
        </Group>
      )}
    </div>
  );
}
