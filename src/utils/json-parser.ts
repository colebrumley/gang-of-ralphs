/**
 * Robust JSON extraction from agent output.
 * Handles JSON embedded in markdown code blocks, bare JSON, and validates required keys.
 */

export class JSONExtractionError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'JSONExtractionError';
  }
}

/**
 * Extract JSON from text that may contain markdown code blocks or other content.
 * @param output - Raw text output from an agent
 * @param requiredKeys - Keys that must be present in the extracted JSON
 * @returns The parsed JSON object
 * @throws JSONExtractionError if no valid JSON found or required keys missing
 */
export function extractJSON<T = unknown>(output: string, requiredKeys: string[] = []): T {
  // Try multiple extraction patterns
  const patterns = [
    // JSON in markdown code blocks with json tag
    /```json\s*([\s\S]*?)```/,
    // JSON in generic markdown code blocks
    /```\s*([\s\S]*?)```/,
    // Bare JSON object
    /(\{[\s\S]*\})/,
    // JSON array
    /(\[[\s\S]*\])/,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      try {
        const jsonStr = match[1].trim();
        const parsed = JSON.parse(jsonStr);

        // Validate required keys
        const missingKeys = requiredKeys.filter((key) => !(key in parsed));
        if (missingKeys.length > 0) {
          continue; // Try next pattern
        }

        return parsed as T;
      } catch {}
    }
  }

  // No valid JSON found
  throw new JSONExtractionError(
    `No valid JSON found in output. Required keys: ${requiredKeys.join(', ')}`,
    output.slice(0, 500)
  );
}
