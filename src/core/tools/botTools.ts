import type { CreateScheduleInput } from '../life/schedules.ts';
import { describeSchedule } from '../life/schedules.ts';
import type { MissedPolicy, ScheduleRecord, WorkItem } from '../types.ts';
import type { ToolCallContext, ToolCallResult, ToolDefinition, ToolHandlers } from './server.ts';

/**
 * SPEC-001 FR-24 / FR-30: the four tools the bot offers its own model. A
 * schedule exists only once the core journaled it, and the result carries the
 * receipt; a question to the owner becomes an `awaiting_owner` work item.
 */

export interface BotToolsDependencies {
  createSchedule(input: CreateScheduleInput): ScheduleRecord;
  listSchedules(): ScheduleRecord[];
  cancelSchedule(id: string): ScheduleRecord;
  askOwner(conversationId: string, question: string): WorkItem;
  now(): Date;
}

const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'schedule_create',
    description: 'Schedule a prompt for yourself: once at a time (ISO 8601 "at" or "delayMinutes") or repeatedly '
      + '(five-field "cron" in an IANA "timezone"). The prompt reaches you in this conversation when it is due. '
      + 'Returns a receipt; a promise in words alone schedules nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What you want to be told or asked when the schedule fires.' },
        at: { type: 'string', description: 'ISO 8601 time for a one-time schedule.' },
        delayMinutes: { type: 'number', description: 'Minutes from now for a one-time schedule, instead of "at".' },
        cron: { type: 'string', description: 'Five-field cron expression for a recurring schedule.' },
        timezone: { type: 'string', description: 'IANA time zone for the cron fields; defaults to the host zone.' },
        missedPolicy: { type: 'string', enum: ['skip', 'coalesce', 'run_once'], description: 'What to do with runs missed while the bot was down.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'schedule_list',
    description: 'List the active schedules of this conversation with their ids and next times.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_cancel',
    description: 'Cancel one of the schedules of this conversation by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ask_owner',
    description: 'Ask your owner a yes/no question before doing something they should approve. '
      + 'The answer arrives later as a new message in this conversation; nothing is approved automatically.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
];

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createBotToolHandlers(deps: BotToolsDependencies): ToolHandlers {
  return {
    list: () => DEFINITIONS,
    async call(name: string, args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
      switch (name) {
        case 'schedule_create': {
          const prompt = stringArg(args, 'prompt');
          if (!prompt) return { text: 'schedule_create needs a prompt', isError: true };
          const cron = stringArg(args, 'cron');
          const at = stringArg(args, 'at');
          const delay = typeof args.delayMinutes === 'number' && Number.isFinite(args.delayMinutes) ? args.delayMinutes : undefined;
          const missedPolicy = stringArg(args, 'missedPolicy') as MissedPolicy | undefined;
          const input: CreateScheduleInput = {
            conversationId: context.conversationId,
            prompt,
            kind: cron ? 'cron' : 'once',
            ...(cron ? { cron } : {}),
            ...(stringArg(args, 'timezone') ? { timezone: stringArg(args, 'timezone') } : {}),
            ...(missedPolicy ? { missedPolicy } : {}),
            createdBy: 'agent',
          };
          if (!cron) {
            if (at) input.at = new Date(at);
            else if (delay !== undefined) input.at = new Date(deps.now().getTime() + delay * 60_000);
            else return { text: 'schedule_create needs "at", "delayMinutes" or "cron"', isError: true };
          }
          const schedule = deps.createSchedule(input);
          return {
            text: `Scheduled ${describeSchedule(schedule)}. Next: ${schedule.nextAt}. Receipt: ${schedule.receipt}`,
          };
        }
        case 'schedule_list': {
          // Each conversation sees only its own schedules, so one note never reads another's prompts.
          const schedules = deps.listSchedules()
            .filter((schedule) => schedule.state === 'active' && schedule.conversationId === context.conversationId);
          if (schedules.length === 0) return { text: 'No active schedules.' };
          return {
            text: schedules.map((schedule) => `${describeSchedule(schedule)} (next ${schedule.nextAt ?? 'never'})`).join('\n'),
          };
        }
        case 'schedule_cancel': {
          const id = stringArg(args, 'id');
          if (!id) return { text: 'schedule_cancel needs an id', isError: true };
          // A schedule of another conversation reads exactly like an unknown id.
          const own = deps.listSchedules()
            .some((schedule) => schedule.id === id && schedule.conversationId === context.conversationId);
          if (!own) return { text: `No schedule ${id} in this conversation`, isError: true };
          const cancelled = deps.cancelSchedule(id);
          return { text: `Cancelled ${cancelled.id}. Receipt: ${cancelled.receipt}` };
        }
        case 'ask_owner': {
          const question = stringArg(args, 'question');
          if (!question) return { text: 'ask_owner needs a question', isError: true };
          const item = deps.askOwner(context.conversationId, question);
          return {
            text: `Your question was handed to your owner as approval ${item.id}. `
              + 'Do not assume an answer; it will arrive as a new message in this conversation.',
          };
        }
        default:
          return { text: `Unknown tool ${name}`, isError: true };
      }
    },
  };
}
