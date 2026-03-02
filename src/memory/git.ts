/**
 * Git Integration for Memory System
 *
 * Checks git status across known projects to surface uncommitted work
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

const CONTEXT_PATH = `${homedir()}/.ai/memory/context.json`;

interface Project {
  name: string;
  path: string;
  description?: string;
  tech_stack?: string[];
  notes?: string;
}

interface UncommittedWork {
  projectName: string;
  projectPath: string;
  filesChanged: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
  summary: string;
}

/**
 * Get list of known projects from context.json
 */
export function getKnownProjects(): Project[] {
  try {
    if (!existsSync(CONTEXT_PATH)) {
      return [];
    }
    const content = readFileSync(CONTEXT_PATH, "utf-8");
    const context = JSON.parse(content);
    return context.current_projects || [];
  } catch (error) {
    console.warn(`Failed to load projects from context.json: ${error}`);
    return [];
  }
}

/**
 * Check git status for a single project
 */
async function checkProjectGitStatus(project: Project): Promise<UncommittedWork | null> {
  try {
    // Check if it's a git repo
    if (!existsSync(`${project.path}/.git`)) {
      return null;
    }

    // Run git status --porcelain
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: project.path,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (!output.trim()) {
      return null; // Clean working tree
    }

    const lines = output.trim().split("\n");
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);

      if (status.startsWith("?")) {
        untracked.push(file);
      } else if (status[0] !== " ") {
        staged.push(file);
      }
      if (status[1] !== " " && status[1] !== "?") {
        unstaged.push(file);
      }
    }

    const filesChanged = [...new Set([...staged, ...unstaged, ...untracked])];

    // Create summary
    const parts: string[] = [];
    if (staged.length > 0) parts.push(`${staged.length} staged`);
    if (unstaged.length > 0) parts.push(`${unstaged.length} modified`);
    if (untracked.length > 0) parts.push(`${untracked.length} untracked`);

    const summary = `${filesChanged.length} files (${parts.join(", ")})`;

    return {
      projectName: project.name,
      projectPath: project.path,
      filesChanged,
      staged,
      unstaged,
      untracked,
      summary,
    };
  } catch (error) {
    console.warn(`Failed to check git status for ${project.name}: ${error}`);
    return null;
  }
}

/**
 * Get all projects with uncommitted work
 * Checks all known projects in parallel
 */
export async function getProjectsWithUncommittedWork(): Promise<UncommittedWork[]> {
  const projects = getKnownProjects();

  const results = await Promise.all(
    projects.map((project) => checkProjectGitStatus(project))
  );

  return results.filter((r): r is UncommittedWork => r !== null);
}

/**
 * Format uncommitted work for prompt injection
 */
export function formatUncommittedWork(work: UncommittedWork[]): string {
  if (work.length === 0) {
    return "";
  }

  const lines = ["**Uncommitted Work:**"];

  for (const w of work) {
    const fileList = w.filesChanged.slice(0, 3).join(", ");
    const more = w.filesChanged.length > 3 ? `, +${w.filesChanged.length - 3} more` : "";
    lines.push(`- ${w.projectName}: ${w.summary} (${fileList}${more})`);
  }

  lines.push("");
  return lines.join("\n");
}
