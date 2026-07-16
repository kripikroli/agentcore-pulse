/**
 * Pattern-based log parser for CloudWatch log events.
 * Loads custom patterns from dashboard/.patterns.json if available.
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Default patterns (used if no .patterns.json exists)
const DEFAULT_PATTERNS = {
  phases: ['Phase started: (.+)', 'Phase completed: (.+)', 'Pipeline completed', 'Pipeline failed', 'phase started', 'phase completed'],
  invocations: ['invokeViaGateway', 'invoke_kiro', 'Invoking kiro-cli', 'invoke-agent-runtime', 'Gateway invoke'],
  errors: ['ERROR', '\\bError\\b', '\\bfailed\\b', 'Exception', 'FATAL', 'Traceback'],
  supervisor: ['tool_call', 'getProjectConfig', 'invokeKiroHarness', 'invokeProductAgent', 'putTaskRecord', 'updateTaskStatus', 'generateGitHubToken', 'fetchIssueDetails'],
};

export class LogParser {
  constructor() {
    this.patterns = this._loadPatterns();
    this._compiledPatterns = this._compilePatterns(this.patterns);
  }

  /**
   * Load patterns from dashboard/.patterns.json if it exists, otherwise use defaults.
   */
  _loadPatterns() {
    const customPath = resolve(process.cwd(), 'dashboard', '.patterns.json');
    if (existsSync(customPath)) {
      try {
        const raw = readFileSync(customPath, 'utf-8');
        const custom = JSON.parse(raw);
        return { ...DEFAULT_PATTERNS, ...custom };
      } catch {
        // Fall back to defaults if file is malformed
        return DEFAULT_PATTERNS;
      }
    }
    return DEFAULT_PATTERNS;
  }

  /**
   * Pre-compile regex patterns for performance.
   */
  _compilePatterns(patterns) {
    const compiled = {};
    for (const [category, patternList] of Object.entries(patterns)) {
      compiled[category] = patternList.map((p) => new RegExp(p, 'i'));
    }
    return compiled;
  }

  /**
   * Detect log level from message content.
   */
  _detectLevel(message) {
    if (/\[ERROR\]|ERROR/i.test(message)) return 'ERROR';
    if (/\[WARN\]|WARN/i.test(message)) return 'WARN';
    return 'INFO';
  }

  /**
   * Match message against pattern categories.
   * Order: errors → phases → invocations → supervisor
   * Returns the category name or 'log' if no match.
   */
  _matchCategory(message) {
    const categoryOrder = ['errors', 'phases', 'invocations', 'supervisor'];
    const typeMap = {
      errors: 'error',
      phases: 'phase',
      invocations: 'invoke',
      supervisor: 'supervisor',
    };

    for (const category of categoryOrder) {
      const regexes = this._compiledPatterns[category];
      if (!regexes) continue;
      for (const regex of regexes) {
        if (regex.test(message)) {
          return typeMap[category];
        }
      }
    }
    return 'log';
  }

  /**
   * Parse a CloudWatch log event into a categorized event object.
   * @param {object} logEvent - CloudWatch log event with timestamp and message
   * @param {string} runtimeName - Name of the source runtime
   * @returns {{ type: string, source: string, level: string, message: string, raw: string, metadata: object }}
   */
  parse(logEvent, runtimeName) {
    const raw = logEvent.message || '';
    const message = raw.trim();
    const level = this._detectLevel(message);
    const type = this._matchCategory(message);

    const metadata = {};

    // Extract timestamp from the log event
    if (logEvent.timestamp) {
      metadata.timestamp = logEvent.timestamp;
    }

    // Extract log group info if present
    if (logEvent.logGroupIdentifier) {
      metadata.logGroup = logEvent.logGroupIdentifier;
    }

    return {
      type,
      source: runtimeName || 'unknown',
      level,
      message,
      raw,
      metadata,
    };
  }
}
