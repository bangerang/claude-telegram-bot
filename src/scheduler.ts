/**
 * Dynamic scheduler for the bot
 * Supports both recurring daily tasks and one-time scheduled messages
 */

import { Bot } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ALLOWED_USERS } from "./config";

const TASKS_FILE = `${process.env.HOME}/.ai/scheduled-tasks.json`;

interface RecurringTask {
  type: "recurring";
  name: string;
  hour: number; // 0-23, in local time (CET/CEST)
  minute: number;
  message: string;
  enabled: boolean;
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
    name: "morning-checkin",
    hour: 9,
    minute: 0,
    message:
      "🌅 Good morning! Quick check-in:\n\n• How did you sleep?\n• Mood right now?\n• Any habits to log? (e.g. \"Improve speaking\")\n\nJust reply naturally and I'll track it for you.",
    enabled: true,
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

      // Send to all allowed users
      for (const userId of ALLOWED_USERS) {
        bot.api.sendMessage(userId, task.message).catch((err) => {
          console.error(`Failed to send scheduled message to ${userId}:`, err);
        });
      }

      console.log(`Recurring task "${task.name}" sent at ${hour}:${minute}`);
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
