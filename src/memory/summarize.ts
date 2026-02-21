/**
 * Conversation Summarization - Generate summaries for ended conversations
 *
 * Uses Claude to analyze conversations and extract:
 * - Summary
 * - Topics
 * - Decisions made
 * - Patterns observed
 * - Tasks completed
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export interface ConversationAnalysis {
  title: string;
  summary: string;
  topics: string[];
  decisions: Array<{
    category: string;
    description: string;
    context?: string;
  }>;
  patterns: Array<{
    category: string;
    pattern: string;
  }>;
  tasks: Array<{
    description: string;
    outcome: string;
    status: "completed" | "partial" | "failed";
  }>;
  knowledge: Array<{
    category: string;
    subject: string;
    content: string;
  }>;
  userSentiment: "positive" | "neutral" | "negative" | "frustrated";
}

const ANALYSIS_PROMPT = `You are analyzing a conversation to extract structured memory for future reference.

Analyze the conversation and extract:

1. **Title**: A short (3-7 word) descriptive title for this conversation
2. **Summary**: 1-2 sentences summarizing what was discussed/accomplished
3. **Topics**: List of main topics discussed (e.g., "iOS development", "speech recognition", "UI design")
4. **Decisions**: Important decisions made during the conversation
   - category: architecture, naming, library, pattern, config, workflow, etc.
   - description: What was decided
   - context: Why it was decided (optional)
5. **Patterns**: User preferences or patterns observed
   - category: coding_style, workflow, communication, naming, etc.
   - pattern: The preference/pattern observed
6. **Tasks**: Work items that were completed or attempted
   - description: What was asked/done
   - outcome: What was accomplished
   - status: completed, partial, or failed
7. **Knowledge**: Facts learned about projects, tools, or domain
   - category: project, tool, api, domain, etc.
   - subject: What this is about
   - content: The fact/knowledge itself
8. **User Sentiment**: Overall tone of the user (positive, neutral, negative, frustrated)

Respond with valid JSON only, no markdown formatting.`;

/**
 * Analyze a conversation and extract structured memory
 */
export async function analyzeConversation(
  conversationText: string
): Promise<ConversationAnalysis> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `${ANALYSIS_PROMPT}\n\n---\n\nCONVERSATION:\n${conversationText}`,
      },
    ],
  });

  // Extract text response
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  // Parse JSON
  try {
    return JSON.parse(textBlock.text) as ConversationAnalysis;
  } catch (error) {
    console.error("Failed to parse analysis JSON:", textBlock.text);
    throw new Error(`Failed to parse conversation analysis: ${error}`);
  }
}

/**
 * Quick summary generation for shorter conversations
 * Uses less tokens for simple summaries
 */
export async function quickSummary(
  conversationText: string
): Promise<{ title: string; summary: string; topics: string[] }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Provide a brief summary of this conversation.

Respond with JSON:
{
  "title": "Short 3-7 word title",
  "summary": "1-2 sentence summary",
  "topics": ["topic1", "topic2", ...]
}

CONVERSATION:
${conversationText}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  try {
    return JSON.parse(textBlock.text);
  } catch (error) {
    // Return defaults if parsing fails
    return {
      title: "Untitled conversation",
      summary: "Conversation summary unavailable",
      topics: [],
    };
  }
}
