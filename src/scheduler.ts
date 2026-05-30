/**
 * Dynamic scheduler for the bot
 * Supports both recurring daily tasks and one-time scheduled messages
 */

import { Bot } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ALLOWED_PATHS,
  ALLOWED_USERS,
  MCP_SERVERS,
  SAFETY_PROMPT,
  WORKING_DIR,
} from "./config";

const TASKS_FILE = `${process.env.HOME}/.ai/scheduled-tasks.json`;

interface RecurringTask {
  type: "recurring";
  name: string;
  hour: number; // 0-23, in local time (CET/CEST)
  minute: number;
  message: string;
  enabled: boolean;
  // If true, run `message` as an agent prompt and post the result to Telegram.
  // If false (or omitted), just post `message` verbatim as a Telegram notification.
  autoExecute?: boolean;
}

interface OneTimeTask {
  type: "onetime";
  id: string;
  scheduledFor: number; // Unix timestamp in ms
  message: string;
  chatId: number;
}

type ScheduledTask = RecurringTask | OneTimeTask;

interface TasksFile {
  tasks: OneTimeTask[];
}

// Built-in recurring tasks
const RECURRING_TASKS: RecurringTask[] = [
  {
    type: "recurring",
    name: "tui-do-daily",
    hour: 8,
    minute: 0,
    message:
      "Give me my daily TUI-DO update. Use the tui-do MCP to list all in-progress and not-started tasks. Group them by project and due date. Highlight anything due today or overdue. Keep the response concise — no preamble, just the list.",
    enabled: true,
    autoExecute: true,
  },
];

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastRunDates: Map<string, string> = new Map();

/**
 * Load one-time tasks from file
 */
function loadTasks(): OneTimeTask[] {
  try {
    if (!existsSync(TASKS_FILE)) {
      return [];
    }
    const data = JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as TasksFile;
    return data.tasks || [];
  } catch (e) {
    console.error("Failed to load scheduled tasks:", e);
    return [];
  }
}

/**
 * Save one-time tasks to file
 */
function saveTasks(tasks: OneTimeTask[]) {
  try {
    const data: TasksFile = { tasks };
    writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to save scheduled tasks:", e);
  }
}

/**
 * Schedule a one-time message
 */
export function scheduleMessage(
  message: string,
  scheduledFor: Date | number,
  chatId: number
): OneTimeTask {
  const tasks = loadTasks();
  const timestamp =
    typeof scheduledFor === "number" ? scheduledFor : scheduledFor.getTime();

  const task: OneTimeTask = {
    type: "onetime",
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scheduledFor: timestamp,
    message,
    chatId,
  };

  tasks.push(task);
  saveTasks(tasks);

  console.log(
    `Scheduled task ${task.id} for ${new Date(timestamp).toLocaleString()}`
  );
  return task;
}

/**
 * List all pending one-time tasks
 */
export function listScheduledTasks(chatId?: number): OneTimeTask[] {
  const tasks = loadTasks();
  const now = Date.now();

  // Filter out expired tasks and optionally filter by chat
  const pending = tasks.filter((t) => {
    if (t.scheduledFor <= now) return false;
    if (chatId !== undefined && t.chatId !== chatId) return false;
    return true;
  });

  return pending.sort((a, b) => a.scheduledFor - b.scheduledFor);
}

/**
 * Cancel a scheduled task by ID
 */
export function cancelTask(taskId: string): boolean {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === taskId);

  if (index === -1) return false;

  tasks.splice(index, 1);
  saveTasks(tasks);
  return true;
}

/**
 * Run a scheduled prompt as an agent query and post the final text response to Telegram.
 * Uses a fresh Claude session each time so it never interferes with the user's active session.
 */
async function runScheduledAgent(
  bot: Bot,
  chatId: number,
  prompt: string,
  taskName: string
) {
  try {
    await bot.api.sendMessage(chatId, `🤖 Running scheduled: ${taskName}...`);

    const finalParts: string[] = [];

    const response = query({
      prompt,
      options: {
        cwd: WORKING_DIR,
        mcpServers: MCP_SERVERS,
        allowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          // Allow all MCP tools by default; tui-do is included via MCP_SERVERS.
        ],
        permissionMode: "bypassPermissions",
        settingSources: ["project", "user"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `${SAFETY_PROMPT}\n\nYou are running on a scheduled timer (no human in the loop). Be concise and self-contained. Do not ask follow-up questions.`,
        },
        additionalDirectories: ALLOWED_PATHS,
      },
    });

    for await (const msg of response as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            finalParts.push(block.text);
          }
        }
      }
    }

    const finalText = finalParts.join("").trim() || "(no response)";

    // Telegram caps at 4096 chars; chunk if needed.
    const MAX = 4000;
    for (let i = 0; i < finalText.length; i += MAX) {
      await bot.api.sendMessage(chatId, finalText.slice(i, i + MAX));
    }

    console.log(`Scheduled agent task "${taskName}" completed`);
  } catch (err) {
    console.error(`Scheduled agent task "${taskName}" failed:`, err);
    try {
      await bot.api.sendMessage(
        chatId,
        `⚠️ Scheduled task "${taskName}" failed: ${String(err).slice(0, 300)}`
      );
    } catch {
      // ignore double-failure
    }
  }
}

/**
 * Check and execute scheduled tasks
 */
function checkScheduledTasks(bot: Bot) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const hour = now.getHours();
  const minute = now.getMinutes();
  const nowMs = now.getTime();

  // Check recurring tasks
  for (const task of RECURRING_TASKS) {
    if (!task.enabled) continue;

    // Check if it's time (within 1 minute window)
    if (hour === task.hour && minute === task.minute) {
      const taskKey = `${today}-${task.name}`;
      if (lastRunDates.get(task.name) === taskKey) continue;

      lastRunDates.set(task.name, taskKey);

      // Send to all allowed users — either as a static notification or as an agent run.
      for (const userId of ALLOWED_USERS) {
        if (task.autoExecute) {
          runScheduledAgent(bot, userId, task.message, task.name).catch(
            (err) =>
              console.error(
                `Scheduled agent ${task.name} failed for ${userId}:`,
                err
              )
          );
        } else {
          bot.api.sendMessage(userId, task.message).catch((err) => {
            console.error(
              `Failed to send scheduled message to ${userId}:`,
              err
            );
          });
        }
      }

      console.log(`Recurring task "${task.name}" fired at ${hour}:${minute}`);
    }
  }

  // Check one-time tasks
  const tasks = loadTasks();
  const remaining: OneTimeTask[] = [];
  let changed = false;

  for (const task of tasks) {
    // Check if task is due (within 30 second window to account for check interval)
    if (task.scheduledFor <= nowMs + 30000 && task.scheduledFor > nowMs - 60000) {
      // Send the message
      bot.api.sendMessage(task.chatId, `⏰ ${task.message}`).catch((err) => {
        console.error(`Failed to send scheduled message:`, err);
      });

      console.log(`One-time task ${task.id} sent`);
      changed = true;
    } else if (task.scheduledFor > nowMs) {
      // Keep future tasks
      remaining.push(task);
    } else {
      // Discard expired tasks
      changed = true;
    }
  }

  if (changed) {
    saveTasks(remaining);
  }
}

/**
 * Start the scheduler
 */
export function startScheduler(bot: Bot) {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  // Check every 30 seconds for better precision on one-time tasks
  schedulerInterval = setInterval(() => {
    checkScheduledTasks(bot);
  }, 30_000);

  // Also check immediately on startup
  checkScheduledTasks(bot);

  console.log("Scheduler started - checking every 30 seconds");
}

/**
 * Stop the scheduler
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
