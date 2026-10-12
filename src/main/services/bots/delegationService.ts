import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { checkFailureText, checkPassed } from '../../../shared/bots/taskCheck';
import type { ProjectedMessage } from '../../../shared/types/agent';
import {
  type BotPermissions,
  botNameKey,
  DELEGATION_TIMEOUT_MINUTES,
  type Delegation,
  type DelegationTrigger,
  type TaskCheck,
} from '../../../shared/types/bot';
import type { BotEvent, BotSendResult } from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR } from '../../../shared/usage/botUsage';
import type { BotAuthorityPort, BotDeliverResult, BotSessionHost } from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import {
  isActiveDelegation as active,
  batchDeliveryId,
  batchResultText,
  batchWaitingNotice,
  delegationBatches,
  delegationResultBody,
  escapeXml,
} from './delegationBatch';
import { delegatedBotPermissions, delegationPolicy } from './delegationPolicy';
import type { DelegationStore } from './delegationStore';
import type { TaskGate } from './groupTasks';
import { previousRunsText } from './previousRuns';
import { rewoundDelegations } from './rewind';

interface Deps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  host: BotSessionHost;
  store: DelegationStore;
  emit: (event: BotEvent) => void;
  /** 一分钟的毫秒数，测试用来压缩时限 */
  minuteMs?: number;
  /** 群任务看板联动：taskId 校验、自动建卡与每次落盘后的状态同步 */
  tasks?: {
    gate(chatId: string | null, ref: string, parentBotId: string, targetBotId?: string): TaskGate;
    open(
      chatId: string,
      botId: string,
      text: string,
      check?: TaskCheck
    ): { taskId: string; seq: number } | undefined;
    discard(chatId: string, taskId: string): void;
    sync(record: Delegation, nestedIn?: string): void;
  };
  /** 子会话当前分支消息（验收读最终工具结果） */
  sessionMessages?: (conversationId: string) => Promise<readonly ProjectedMessage[]>;
  deliverGroupResult?: (
    record: Delegation,
    text: string,
    deliveryId: string
  ) => Promise<BotSendResult>;
}
export interface DelegateInput {
  to: string;
  task: string;
  context?: string;
  /** 看板任务（#N 或 id）；委派创建 / 终态同步任务状态 */
  taskId?: string;
  /** 期望时限（分钟），不超过目标成员的委派时限 */
  deadlineMinutes?: number;
  /** 父回合被停止 / 中断后仍继续 */
  keep?: boolean;
  /** 验收条件；不传时沿用关联看板任务的 */
  check?: TaskCheck;
}
export type DelegateResult =
  | { ok: true; delegationId: string; taskId?: string; warning?: string }
  | { ok: false; error: string };
export type DelegationRetryMode = 'resume' | 'restart';

/** 续跑没成但会话本身没坏：照常记失败，不退回从头 */
const RESUME_TRANSIENT = new Set(['session-busy', 'disabled', BOT_BUDGET_ERROR]);

interface Resume {
  conversationId: string;
  /** 验收没过：在原会话补一条未通过原因，而不是从最后一步续跑 */
  checkFailed: boolean;
}

/** 投递任务时的看板信息：#N、是否接着原会话、改派时带的退回理由 */
interface TaskInfo {
  seq?: number;
  incremental?: boolean;
  returnReason?: string;
}

const samePermissions = (a: BotPermissions | undefined, b: BotPermissions) =>
  !!a &&
  a.tools === b.tools &&
  a.approvalMode === b.approvalMode &&
  [...a.skillIds].sort().join('\n') === [...b.skillIds].sort().join('\n') &&
  [...a.mcpServerIds].sort().join('\n') === [...b.mcpServerIds].sort().join('\n');

export class DelegationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delivering = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDiscard: () => void;
  private readonly unsubscribeStarted: () => void;
  private disposed = false;
  private discarding = false;

  constructor(private readonly deps: Deps) {
    this.unsubscribeStarted = deps.host.onDeliveryStarted((event) => {
      const batch = delegationBatches(
        deps.store.list().filter((record) => record.parentConversationId === event.conversationId)
      ).find((items) => batchDeliveryId(items) === event.deliveryId);
      if (batch && !batch.some(active)) this.delivered(batch);
    });
    this.unsubscribeDiscard = deps.host.onDiscard((scope) => {
      // 级联取消不是“批次里有人结束”，不写等待提示
      this.discarding = true;
      try {
        for (const record of deps.store.list()) {
          if (
            (scope.chatId && record.chatId === scope.chatId) ||
            (scope.botId &&
              (record.parentBotId === scope.botId || record.targetBotId === scope.botId)) ||
            (scope.conversationId && record.parentConversationId === scope.conversationId)
          )
            this.cancel(record.id);
        }
      } finally {
        this.discarding = false;
      }
    });
    for (const record of deps.store.list()) {
      if (active(record))
        this.save({ ...record, state: 'failed', failure: 'interrupted', finishedAt: Date.now() });
    }
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.stopped && event.turnKey) this.stopBatch(event.conversationId, event.turnKey);
      if (event.delegationId) {
        // 续跑的新记录沿用原子会话，会话绑定的仍是最初的委派 id
        const record = deps.store
          .list()
          .find((item) => item.childConversationId === event.conversationId && active(item));
        if (record) {
          if (event.ok && record.check) void this.verify(record, record.check, event.text);
          else
            this.finish(
              record,
              event.ok ? 'completed' : 'failed',
              event.ok ? undefined : 'error',
              event.text,
              event.error
            );
        }
      }
      queueMicrotask(() => {
        void this.deliverPending();
      });
    });
    queueMicrotask(() => {
      void this.deliverPending();
    });
  }

  private upstreamBots(record: Delegation): Set<string> {
    const ids = new Set<string>();
    for (let item: Delegation | undefined = record; item && !ids.has(item.parentBotId); ) {
      ids.add(item.parentBotId);
      item = this.deps.authority.conversation(item.parentConversationId)?.bot?.delegationId
        ? this.executionOf(item.parentConversationId)
        : undefined;
    }
    return ids;
  }

  /** 同一轮发起的委派共享 batchId（父会话轮次键），结果齐了合并回传；standalone 自成一批 */
  delegate(
    parentConversationId: string,
    input: DelegateInput,
    options: {
      standalone?: boolean;
      retryOf?: string;
      resume?: Resume;
      trigger?: DelegationTrigger;
      /** 不续用任务会话（手动「从头重试」） */
      fresh?: boolean;
    } = {}
  ): DelegateResult {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const conversation = this.deps.authority.conversation(parentConversationId);
    let parent = this.deps.host.effectiveBot(parentConversationId);
    const target = this.deps.bots
      .list()
      .find((bot) => bot.id === input.to || botNameKey(bot.name) === botNameKey(input.to));
    if (!conversation?.bot || conversation.lifecycle === 'ended' || !parent)
      return { ok: false, error: 'Parent bot session unavailable.' };
    if (!target) return { ok: false, error: `Unknown member: ${input.to}` };
    if (!input.task.trim()) return { ok: false, error: 'Task must not be empty.' };
    const deadline = input.deadlineMinutes;
    if (deadline !== undefined && !(Number.isFinite(deadline) && deadline > 0))
      return { ok: false, error: 'deadlineMinutes must be a positive number.' };
    const limit = target.delegationTimeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES;
    const timeoutMinutes = Math.min(deadline ?? limit, limit);
    // 子会话可能先后挂多次执行：按最新一次算祖先
    const ancestor = conversation.bot.delegationId
      ? this.executionOf(parentConversationId)
      : undefined;
    if (conversation.bot.delegationId && !ancestor)
      return { ok: false, error: 'Parent delegation record unavailable.' };
    if (ancestor) {
      // 重启后 effectiveBot 回落到原始档案，审批档仍按祖先委派快照收紧
      parent = delegatedBotPermissions(
        { ...parent, approvalMode: ancestor.effectivePermissions?.approvalMode ?? 'supervised' },
        parent
      );
    }
    // 结果本来就会自动回传给上游，往回委派只会绕圈
    if (ancestor && this.upstreamBots(ancestor).has(target.id))
      return {
        ok: false,
        error: `${target.name} delegated this work to you; your final reply is returned to them automatically.`,
      };
    const depth = (ancestor ? ancestor.depth : 0) + 1;
    const chatId = conversation.bot.chatId ?? (ancestor ? ancestor.chatId : null);
    const chat = chatId ? this.deps.chats.get(chatId) : undefined;
    if (chatId && (!chat || chat.archivedAt !== undefined))
      return { ok: false, error: 'Parent chat unavailable.' };
    const count = this.deps.store
      .list()
      .filter(
        (record) => record.parentConversationId === parentConversationId && active(record)
      ).length;
    const error = delegationPolicy(
      parent,
      target,
      depth,
      count,
      chat?.kind === 'group' ? chat.members : undefined
    );
    if (error) return { ok: false, error };
    let task: Omit<Extract<TaskGate, { ok: true }>, 'ok'> | undefined;
    let opened = false;
    let check = input.check;
    if (input.taskId !== undefined) {
      const gate = this.deps.tasks?.gate(chatId, input.taskId, parent.id, target.id) ?? {
        ok: false as const,
        error: 'Tasks are only available in group chats.',
      };
      if (!gate.ok) return gate;
      task = gate;
      check ??= gate.check;
    } else if (
      chatId &&
      chat?.kind === 'group' &&
      depth === 1 &&
      !options.retryOf &&
      !options.resume
    ) {
      task = this.deps.tasks?.open(chatId, parent.id, input.task, check);
      opened = task !== undefined;
    }
    const taskId = task?.taskId;
    const id = randomUUID();
    const batchId = options.standalone ? undefined : this.deps.host.turnKey(parentConversationId);
    const projectId = conversation.projectId;
    // 同一任务同一成员才续会话：会话由看板按任务真实 id + 成员给出，这里再核对归属与可用性
    const reuse =
      !options.resume &&
      !options.fresh &&
      task?.session &&
      this.reusable(task.session, target.id, projectId, task.taskId)
        ? task.session
        : undefined;
    const continued = options.resume?.conversationId ?? reuse;
    const child = continued
      ? this.deps.authority.conversation(continued)
      : this.newChild(projectId, target.id, id);
    const effective = delegatedBotPermissions(parent, target);
    const permissions: BotPermissions = {
      tools: effective.tools,
      approvalMode: effective.approvalMode,
      skillIds: effective.skillIds,
      mcpServerIds: effective.mcpServerIds,
    };
    const previous = continued ? this.executionOf(continued) : undefined;
    const respawn =
      previous !== undefined && !samePermissions(previous.effectivePermissions, permissions);
    const trigger: DelegationTrigger =
      options.trigger ?? (options.retryOf ? 'retry' : (task?.trigger ?? 'delegate'));
    // 群主再派给失败的原执行人：就是对那次失败执行的重试
    const retryOf =
      options.retryOf ??
      (trigger === 'retry' && previous?.state === 'failed' && previous.taskId === taskId
        ? previous.id
        : undefined);
    const origin = { parentConversationId, chatId };
    if (!child || !this.deps.host.registerDelegation(child.conversationId, effective, origin)) {
      if (opened && chatId && taskId) this.deps.tasks?.discard(chatId, taskId);
      return { ok: false, error: 'Delegation workspace unavailable.' };
    }
    const record: Delegation = {
      id,
      parentConversationId,
      parentBotId: parent.id,
      targetBotId: target.id,
      chatId,
      task: input.task,
      context: (input.context ?? '').slice(0, 8000),
      childConversationId: child.conversationId,
      state: 'queued',
      depth,
      createdAt: Date.now(),
      effectivePermissions: permissions,
      ...(batchId ? { batchId } : {}),
      ...(taskId ? { taskId } : {}),
      // 返工 / 追加不挂 retryOf：验收只认本次执行开始后的证据
      ...(retryOf ? { retryOf } : {}),
      ...(input.keep ? { keep: true } : {}),
      ...(check ? { check: { kind: check.kind, text: check.text } } : {}),
      timeoutMinutes,
      trigger,
    };
    this.save(record);
    const info: TaskInfo = {
      ...(task ? { seq: task.seq } : {}),
      ...(reuse ? { incremental: true } : {}),
      ...(task?.returnReason && trigger === 'delegate' ? { returnReason: task.returnReason } : {}),
    };
    const freshChild = () => {
      const fresh = this.newChild(projectId, target.id, id);
      return fresh && this.deps.host.registerDelegation(fresh.conversationId, effective, origin)
        ? fresh.conversationId
        : undefined;
    };
    // 权限或工具变了：先释放空闲实例，下次开工按新配置和原 jsonl 重新 spawn（不走停止）
    const ready =
      respawn && continued ? this.deps.host.releaseIdle(continued) : Promise.resolve(false);
    const sending = ready.then(() =>
      options.resume
        ? this.resume(record, options.resume, freshChild, parent.name, info)
        : this.sendTask(record, parent.name, info)
    );
    void sending
      .then((sent) => {
        const current = this.deps.store.get(id);
        if (!current || !active(current)) return;
        if (!sent.ok) this.finish(current, 'failed', 'error', undefined, sent.error);
        else if (!sent.queued) this.started(current);
      })
      .catch((cause) => {
        const current = this.deps.store.get(id);
        if (current && active(current))
          this.finish(current, 'failed', 'error', undefined, String(cause));
      });
    const warnings = [
      ...((input.context?.length ?? 0) > 8000 ? ['Context truncated to 8000 characters.'] : []),
      ...(deadline !== undefined && deadline > limit
        ? [`Deadline capped at ${limit} minutes (${target.name}'s delegation limit).`]
        : []),
    ];
    return {
      ok: true,
      delegationId: id,
      ...(task ? { taskId: `#${task.seq}` } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    };
  }

  list(chatId?: string): Delegation[] {
    return this.deps.store.list(chatId);
  }

  private newChild(projectId: string, botId: string, delegationId: string) {
    return this.deps.authority.createBotConversation(projectId, {
      botId,
      chatId: null,
      delegationId,
    });
  }

  /** 子会话当前（最新）一次执行；会话绑定的 delegationId 只是第一次 */
  executionOf(childConversationId: string): Delegation | undefined {
    let latest: Delegation | undefined;
    for (const record of this.deps.store.list())
      if (
        record.childConversationId === childConversationId &&
        (!latest || record.createdAt >= latest.createdAt)
      )
        latest = record;
    return latest;
  }

  /** 任务会话可续：未结束、成员与项目一致、最近一次执行属于本任务且已结束、jsonl 还在 */
  private reusable(conversationId: string, botId: string, projectId: string, taskId: string) {
    const child = this.deps.authority.conversation(conversationId);
    const last = this.executionOf(conversationId);
    const file = child?.sessionFile;
    return (
      !!child &&
      child.lifecycle !== 'ended' &&
      child.projectId === projectId &&
      child.bot?.botId === botId &&
      !!child.bot.delegationId &&
      last?.taskId === taskId &&
      last.depth === 1 &&
      !active(last) &&
      !!file &&
      existsSync(file)
    );
  }

  /** 任务的历次执行（深度 1），按发起先后 */
  private taskRuns(taskId: string): Delegation[] {
    return this.deps.store
      .list()
      .filter((record) => record.taskId === taskId && record.depth === 1)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 续用会话只发增量；新会话发完整任务，任务有历次执行时附 <previous-runs> */
  private sendTask(
    record: Delegation,
    from: string,
    info: TaskInfo = {}
  ): Promise<BotDeliverResult> {
    const acceptance = record.check
      ? `\n<acceptance-check>Passes only if one of your final tool outputs (e.g. a command's output) contains: ${escapeXml(record.check.text)}</acceptance-check>`
      : '';
    const runs = record.taskId ? this.taskRuns(record.taskId) : [];
    const index = runs.findIndex((item) => item.id === record.id);
    let text: string;
    if (info.incremental && info.seq !== undefined && index >= 0) {
      const context = record.context ? `\n<context>${escapeXml(record.context)}</context>` : '';
      text = `<delegation-task id="${record.id}" from="${escapeXml(from)}" task="#${info.seq}" run="${index + 1}" trigger="${record.trigger ?? 'delegate'}">\n${escapeXml(record.task)}${context}${acceptance}\n</delegation-task>`;
    } else {
      const previous = previousRunsText(index >= 0 ? runs.slice(0, index) : [], {
        name: (id) => this.deps.bots.get(id)?.name ?? id,
        ...(info.returnReason ? { returnReason: info.returnReason } : {}),
      });
      text = `<delegation-task id="${record.id}" from="${escapeXml(from)}">\n${escapeXml(record.task)}\n<context>${escapeXml(record.context)}</context>${acceptance}${previous ? `\n${previous}` : ''}\n</delegation-task>`;
    }
    return this.deps.host.deliverConversation(record.childConversationId, text, {
      deliveryId: record.id,
      queueIfBusy: true,
      source: 'bot',
    });
  }

  /** 沿用原子会话：中途失败从最后一步续跑，验收没过补一条原因；会话恢复不了才换新子会话从头发任务 */
  private async resume(
    record: Delegation,
    resume: Resume,
    freshChild: () => string | undefined,
    from: string,
    info: TaskInfo
  ): Promise<BotDeliverResult> {
    const sent =
      resume.checkFailed && record.check
        ? await this.deps.host.deliverConversation(
            resume.conversationId,
            `<delegation-check-failed id="${record.id}">\nThe acceptance check failed: none of your final tool outputs contained: ${escapeXml(record.check.text)}\nFix the work and finish again; this delegation passes only if one of your final tool outputs contains it.\n</delegation-check-failed>`,
            { deliveryId: record.id, queueIfBusy: true, source: 'bot' }
          )
        : await this.deps.host.retryConversation(resume.conversationId, { delegation: true });
    if (sent.ok || RESUME_TRANSIENT.has(sent.error)) return sent;
    const current = this.deps.store.get(record.id);
    if (!current || !active(current)) return sent;
    const conversationId = freshChild();
    if (!conversationId) return { ok: false, error: 'Delegation workspace unavailable.' };
    const fresh = { ...current, childConversationId: conversationId };
    this.save(fresh);
    return this.sendTask(fresh, from, { ...info, incremental: false });
  }

  check(parentConversationId: string, input: { id?: string; cancel?: boolean }): unknown {
    const records = this.list().filter(
      (record) =>
        record.parentConversationId === parentConversationId &&
        (!input.id || record.id === input.id)
    );
    if (input.id && !records.length)
      return { ok: false, error: 'Delegation not found in this parent session.' };
    if (input.cancel) {
      if (!input.id) return { ok: false, error: 'Specify id to cancel a delegation.' };
      return this.cancel(input.id);
    }
    return { ok: true, delegations: records };
  }

  /** 委派所属聊天（共享浏览器等按聊天归属的资源用） */
  chatIdOf(id: string): string | null {
    return this.deps.store.get(id)?.chatId ?? null;
  }

  /** 委派发起成员 */
  parentBotOf(id: string): string | undefined {
    return this.deps.store.get(id)?.parentBotId;
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const record = this.deps.store.get(id);
    if (!record) return { ok: false, error: 'Delegation not found.' };
    if (!active(record)) return { ok: true };
    this.finish(record, 'canceled');
    void this.deps.host.abortConversation(record.childConversationId).catch(console.warn);
    return { ok: true };
  }

  /** 默认从断点续跑；手动取消的须由用户选 resume / restart，子会话丢失或文件不在才从头 */
  retry(id: string, mode?: DelegationRetryMode): DelegateResult {
    const record = this.deps.store.get(id);
    if (!record || (record.state !== 'failed' && record.state !== 'canceled'))
      return {
        ok: false,
        error: 'Only failed, canceled or interrupted delegations can be retried.',
      };
    if (record.state === 'canceled' && !mode)
      return { ok: false, error: 'Choose to resume or restart a canceled delegation.' };
    if (this.deps.store.list().some((item) => item.retryOf === id))
      return { ok: false, error: 'This delegation has already been retried.' };
    // 任务仍空闲（已退回待办）时沿用关联；已完成 / 取消 / 被别人接手则不再绑定
    const taskId =
      record.taskId &&
      this.deps.tasks?.gate(record.chatId, record.taskId, record.parentBotId, record.targetBotId).ok
        ? record.taskId
        : undefined;
    const child = this.deps.authority.conversation(record.childConversationId);
    const file = child && child.lifecycle !== 'ended' ? child.sessionFile : undefined;
    const resume =
      mode !== 'restart' && file && existsSync(file)
        ? { conversationId: record.childConversationId, checkFailed: record.failure === 'check' }
        : undefined;
    // 重试是用户在轮次之外的操作，不并入原批次，也不并入父会话当前轮次；群里开过新对话就从委派人的新会话发起
    return this.delegate(
      this.delegatorSession(record) ?? record.parentConversationId,
      {
        to: record.targetBotId,
        task: record.task,
        context: record.context,
        ...(taskId ? { taskId } : {}),
        ...(record.timeoutMinutes ? { deadlineMinutes: record.timeoutMinutes } : {}),
        ...(record.check ? { check: { kind: record.check.kind, text: record.check.text } } : {}),
      },
      {
        standalone: true,
        retryOf: id,
        ...(resume ? { resume } : {}),
        ...(mode === 'restart' ? { fresh: true } : {}),
      }
    );
  }

  /**
   * 退回返工：原执行人在本任务会话里新开一次执行（trigger rework，不挂 retryOf）。
   * 成员验收时结果回到它当前群会话；人验收时回到委派人的会话，群里开过新对话就回到新会话。
   */
  rework(input: {
    chatId: string;
    delegationId: string;
    actor: string;
    reason: string;
  }): DelegateResult {
    const last = this.deps.store.get(input.delegationId);
    if (!last?.taskId) return { ok: false, error: 'Delegation not found.' };
    const human = input.actor === 'human';
    const parentConversationId = human
      ? this.delegatorSession(last)
      : this.deps.chats.get(input.chatId)?.sessions[input.actor]?.conversationId;
    if (!parentConversationId) return { ok: false, error: 'Parent bot session unavailable.' };
    const by = human
      ? 'a human reviewer'
      : (this.deps.bots.get(input.actor)?.name ?? 'the reviewer');
    return this.delegate(
      parentConversationId,
      {
        to: last.targetBotId,
        taskId: last.taskId,
        task: `Your delivery was returned for rework by ${by}. Reason:\n${input.reason}`,
        ...(last.timeoutMinutes ? { deadlineMinutes: last.timeoutMinutes } : {}),
      },
      { standalone: human, trigger: 'rework' }
    );
  }

  /** 委派人的会话：原会话还在用原会话，群聊里原会话已结束（新对话）就用它在该群的当前会话 */
  private delegatorSession(record: Delegation): string | undefined {
    const parent = this.deps.authority.conversation(record.parentConversationId);
    if (parent && parent.lifecycle !== 'ended') return parent.conversationId;
    if (
      !record.chatId ||
      record.depth !== 1 ||
      this.deps.chats.get(record.chatId)?.kind !== 'group'
    )
      return undefined;
    const session = this.deps.host.ensureSession(record.chatId, record.parentBotId);
    return session.ok ? session.conversationId : undefined;
  }

  /** 父回合被停止：取消该轮发起且未 keep 的委派；整批都已结束则只落时间线，不再唤醒父会话 */
  private stopBatch(parentConversationId: string, batchId: string): void {
    const batch = () =>
      this.deps.store
        .list()
        .filter(
          (record) =>
            record.parentConversationId === parentConversationId && record.batchId === batchId
        );
    this.discarding = true;
    try {
      for (const record of batch()) if (active(record) && !record.keep) this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const rest = batch();
    if (rest.length && !rest.some(active)) this.delivered(rest);
  }

  /** 群开新对话：未 keep 的取消，已结束未投递的只落时间线；keep 的跑完后父会话已结束，同样只落时间线 */
  startOver(chatId: string): void {
    const records = () => this.deps.store.list().filter((record) => record.chatId === chatId);
    this.discarding = true;
    try {
      for (const record of records()) if (active(record) && !record.keep) this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const done = records().filter((record) => !active(record) && record.deliveredAt === undefined);
    if (done.length) this.delivered(done);
  }

  /** 私聊回退越过发起委派的回合：取消进行中的，未投递结果一律作废（规则见 rewoundDelegations） */
  discardRewound(parentConversationId: string, since: number): void {
    const { cancel, discard } = rewoundDelegations(this.list(), parentConversationId, since);
    this.discarding = true;
    try {
      for (const id of cancel) this.cancel(id);
    } finally {
      this.discarding = false;
    }
    const records = discard.flatMap((id) => this.deps.store.get(id) ?? []);
    if (records.length) this.delivered(records);
  }

  observeRunning(conversationId: string): void {
    const record = this.list().find(
      (item) => item.childConversationId === conversationId && item.state === 'queued'
    );
    if (record) this.started(record);
  }

  /** queued → running 的唯一入口：期限从真正开工起算 */
  private started(record: Delegation): void {
    if (record.state !== 'queued' || this.disposed) return;
    this.save({ ...record, state: 'running', startedAt: Date.now() });
    const timer = setTimeout(
      () => {
        const current = this.deps.store.get(record.id);
        if (current && active(current)) {
          this.finish(current, 'failed', 'timeout');
          void this.deps.host.abortConversation(current.childConversationId).catch(console.warn);
        }
      },
      (record.timeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES) * (this.deps.minuteMs ?? 60_000)
    );
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  async deliverPending(parentConversationId?: string): Promise<void> {
    if (this.disposed) return;
    for (const batch of delegationBatches(this.list())) {
      const head = batch[0];
      const deliveryId = batchDeliveryId(batch);
      if (
        batch.some(active) ||
        batch.every((record) => record.deliveredAt !== undefined) ||
        this.delivering.has(deliveryId) ||
        (parentConversationId && head.parentConversationId !== parentConversationId) ||
        this.deps.host.isBusy(head.parentConversationId)
      )
        continue;
      const parent = this.deps.authority.conversation(head.parentConversationId);
      if (!parent || parent.lifecycle === 'ended') {
        if (head.chatId && this.deps.chats.get(head.chatId)?.kind === 'group')
          this.delivered(batch);
        continue;
      }
      if (this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId)) {
        this.delivered(batch);
        continue;
      }
      if (parent.bot?.delegationId) {
        const bot = this.deps.bots.get(head.parentBotId);
        const record = this.executionOf(parent.conversationId);
        const saved = record?.effectivePermissions;
        // Interrupted delegation parents must not be restarted with their original task.
        if (
          !bot ||
          !this.deps.host.registerDelegation(
            parent.conversationId,
            {
              ...bot,
              ...(saved ? { skillIds: saved.skillIds, mcpServerIds: saved.mcpServerIds } : {}),
              tools: 'readonly',
              approvalMode: 'supervised',
            },
            record
              ? { parentConversationId: record.parentConversationId, chatId: record.chatId }
              : undefined
          )
        )
          continue;
      }
      this.delivering.add(deliveryId);
      try {
        const text = batchResultText(batch, (id) => this.deps.bots.get(id)?.name ?? id);
        const sent =
          parent.bot?.chatId &&
          this.deps.chats.get(parent.bot.chatId)?.kind === 'group' &&
          this.deps.deliverGroupResult
            ? await this.deps.deliverGroupResult(head, text, deliveryId)
            : await this.deps.host.deliverConversation(head.parentConversationId, text, {
                onlyIfIdle: true,
                source: 'bot',
                deliveryId,
              });
        if (sent.ok && this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId))
          this.delivered(batch);
      } catch (cause) {
        console.warn('[bots] delegation delivery failed', cause);
      } finally {
        this.delivering.delete(deliveryId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeDiscard();
    this.unsubscribeStarted();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  disable(): void {
    this.disposed = true;
    for (const record of this.deps.store.list()) if (active(record)) this.cancel(record.id);
    this.dispose();
  }

  private finish(
    record: Delegation,
    state: Delegation['state'],
    failure?: Delegation['failure'],
    result?: string,
    error?: string
  ): void {
    clearTimeout(this.timers.get(record.id));
    this.timers.delete(record.id);
    const finished: Delegation = {
      ...record,
      state,
      finishedAt: Date.now(),
      ...(failure ? { failure } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    };
    this.save(finished);
    this.noticeWaiting(finished);
    queueMicrotask(() => {
      void this.deliverPending(record.parentConversationId);
    });
  }

  /** 委派开始后子会话的最终工具结果里找验收文本；读失败按未通过 */
  private async verify(record: Delegation, check: TaskCheck, text: string): Promise<void> {
    let passed = false;
    try {
      const messages = await this.deps.sessionMessages?.(record.childConversationId);
      passed = messages ? checkPassed(check, messages, this.startedAt(record)) : false;
    } catch (cause) {
      console.warn('[bots] delegation check read failed', cause);
    }
    const current = this.deps.store.get(record.id);
    if (this.disposed || !current || !active(current)) return;
    const checked = { ...current, check: { ...check, passed } };
    if (passed) this.finish(checked, 'completed', undefined, text);
    else this.finish(checked, 'failed', 'check', text, checkFailureText(check));
  }

  /** 同一子会话上的续跑链从最初那次委派起算 */
  private startedAt(record: Delegation): number {
    let start = record;
    for (
      let prev = record.retryOf ? this.deps.store.get(record.retryOf) : undefined;
      prev?.childConversationId === record.childConversationId;
      prev = prev.retryOf ? this.deps.store.get(prev.retryOf) : undefined
    )
      start = prev;
    return start.createdAt;
  }

  /** 批次未齐：在群时间线提示谁结束了、还在等谁 */
  private noticeWaiting(record: Delegation): void {
    if (this.disposed || this.discarding || !record.batchId || !record.chatId) return;
    if (this.deps.chats.get(record.chatId)?.kind !== 'group') return;
    const batch = this.deps.store
      .list()
      .filter(
        (item) =>
          item.parentConversationId === record.parentConversationId &&
          item.batchId === record.batchId
      );
    const text = batchWaitingNotice(batch, record, (id) => this.deps.bots.get(id)?.name ?? id);
    if (!text) return;
    const saved = this.deps.chats.appendEntry(record.chatId, {
      kind: 'system',
      id: randomUUID(),
      at: Date.now(),
      text,
    });
    if (saved) this.deps.emit({ kind: 'timeline', chatId: record.chatId, seq: saved.seq });
  }

  private delivered(batch: readonly Delegation[]): void {
    for (const record of batch) {
      const latest = this.deps.store.get(record.id);
      if (!latest || latest.deliveredAt !== undefined) continue;
      if (record.chatId && this.deps.chats.get(record.chatId)?.kind === 'group') {
        if (!this.deps.chats.hasEntry(record.chatId, `delegation:${record.id}`))
          this.deps.chats.appendEntry(record.chatId, {
            kind: 'delegation',
            id: `delegation:${record.id}`,
            at: Date.now(),
            delegationId: record.id,
            from: record.parentBotId,
            to: record.targetBotId,
            state: record.state,
            summary: delegationResultBody(record).slice(0, 500),
          });
        this.deps.emit({ kind: 'timeline', chatId: record.chatId });
      }
      this.save({ ...latest, deliveredAt: Date.now() });
    }
  }

  private save(record: Delegation): void {
    this.deps.store.save(record);
    const nestedIn = record.taskId ? undefined : this.nestedIn(record);
    if (nestedIn) this.deps.tasks?.sync(record, nestedIn);
    else this.deps.tasks?.sync(record);
    this.deps.emit({ kind: 'delegation', ...(record.chatId ? { chatId: record.chatId } : {}) });
  }

  /** 嵌套执行所属的上层任务：发起它的那次执行（父会话上最近一条记录）挂的任务 */
  private nestedIn(record: Delegation): string | undefined {
    if (record.depth < 2) return undefined;
    return this.executionOf(record.parentConversationId)?.taskId;
  }
}
