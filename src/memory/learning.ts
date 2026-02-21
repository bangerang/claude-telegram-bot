/**
 * Auto-Learning Module - Detects patterns and feedback from user messages
 *
 * Analyzes user messages to:
 * - Detect frustration/corrections
 * - Identify explicit preferences
 * - Record implicit patterns
 */

import { recordFeedback, recordPattern } from "./db";

// Frustration indicators
const FRUSTRATION_PATTERNS = [
  /no,?\s*(not|wrong|that'?s not)/i,
  /i said/i,
  /i already told you/i,
  /why (did|do|are) you/i,
  /that'?s (not|wrong)/i,
  /stop/i,
  /don'?t/i,
  /fucking|fuck|shit|damn|retard/i,
  /wtf|wth/i,
  /🙄|😤|😡|🤦/,
];

// Correction patterns - capture what was wrong
const CORRECTION_PATTERNS = [
  /no,?\s*(?:use|do|make|it'?s)\s+(.+)/i,
  /(?:should be|should have been)\s+(.+)/i,
  /(?:i wanted|i meant|i need)\s+(.+)/i,
  /(?:not|don'?t)\s+(.+?),?\s*(?:but|use|do)\s+(.+)/i,
];

// Explicit preference patterns
const PREFERENCE_PATTERNS = [
  /i (?:always|usually|prefer to|like to)\s+(.+)/i,
  /(?:always|never)\s+(?:use|do|make)\s+(.+)/i,
  /i (?:want|need) you to (?:always|never)\s+(.+)/i,
  /(?:from now on|going forward),?\s*(.+)/i,
  /remember (?:to|that)\s+(.+)/i,
];

export interface FeedbackAnalysis {
  hasFrustration: boolean;
  corrections: string[];
  preferences: string[];
  sentiment: "positive" | "neutral" | "negative" | "frustrated";
}

/**
 * Analyze a user message for feedback signals
 */
export function analyzeMessage(message: string): FeedbackAnalysis {
  const analysis: FeedbackAnalysis = {
    hasFrustration: false,
    corrections: [],
    preferences: [],
    sentiment: "neutral",
  };

  // Check for frustration
  for (const pattern of FRUSTRATION_PATTERNS) {
    if (pattern.test(message)) {
      analysis.hasFrustration = true;
      analysis.sentiment = "frustrated";
      break;
    }
  }

  // Extract corrections
  for (const pattern of CORRECTION_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      // Capture the correction (groups 1 or 2)
      const correction = match[1] || match[2];
      if (correction && correction.length > 3 && correction.length < 200) {
        analysis.corrections.push(correction.trim());
      }
    }
  }

  // Extract preferences
  for (const pattern of PREFERENCE_PATTERNS) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const preference = match[1].trim();
      if (preference.length > 3 && preference.length < 200) {
        analysis.preferences.push(preference);
      }
    }
  }

  // Determine sentiment if not frustrated
  if (!analysis.hasFrustration) {
    if (/thanks|thank you|perfect|great|awesome|nice|good job/i.test(message)) {
      analysis.sentiment = "positive";
    } else if (analysis.corrections.length > 0) {
      analysis.sentiment = "negative";
    }
  }

  return analysis;
}

/**
 * Process user feedback and store in memory
 */
export async function processUserFeedback(
  message: string,
  conversationId?: string,
  context?: string
): Promise<void> {
  const analysis = analyzeMessage(message);

  // Record frustration/corrections
  if (analysis.hasFrustration || analysis.corrections.length > 0) {
    const type = analysis.hasFrustration ? "complaint" : "correction";

    for (const correction of analysis.corrections) {
      recordFeedback(type, correction, {
        conversationId,
        context,
      });

      // Also record as a potential pattern
      recordPattern("user_correction", correction, { conversationId });
    }

    // If frustrated but no specific correction captured, record the message
    if (analysis.hasFrustration && analysis.corrections.length === 0) {
      recordFeedback("complaint", message.slice(0, 200), {
        conversationId,
        context,
      });
    }
  }

  // Record explicit preferences
  for (const preference of analysis.preferences) {
    recordFeedback("preference", preference, {
      conversationId,
      context,
    });

    // Also record as a pattern
    recordPattern("explicit_preference", preference, { conversationId });
  }

  // Record positive feedback
  if (analysis.sentiment === "positive") {
    recordFeedback("praise", message.slice(0, 200), {
      conversationId,
      context,
    });
  }
}

/**
 * Extract and learn from coding patterns in the conversation
 * Called periodically or at end of session
 */
export function learnFromContext(
  toolsUsed: string[],
  filesModified: string[],
  conversationId?: string
): void {
  // Learn file type patterns
  const extensions = new Set<string>();
  for (const file of filesModified) {
    const ext = file.split(".").pop();
    if (ext) extensions.add(ext);
  }

  // Learn tool usage patterns
  const toolCounts = new Map<string, number>();
  for (const tool of toolsUsed) {
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  }

  // Record frequently used tools
  for (const [tool, count] of toolCounts.entries()) {
    if (count >= 3) {
      recordPattern("tool_usage", `Frequently uses ${tool}`, {
        conversationId,
      });
    }
  }
}
