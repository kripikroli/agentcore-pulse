/**
 * CloudWatch LiveTail collector — streams logs from AgentCore runtimes.
 * Uses StartLiveTailCommand from @aws-sdk/client-cloudwatch-logs.
 */
import { CloudWatchLogsClient, StartLiveTailCommand } from '@aws-sdk/client-cloudwatch-logs';
import { fromIni } from '@aws-sdk/credential-providers';
import { LogParser } from './log-parser.js';

const RECONNECT_DELAY_MS = 2000;

export class CloudWatchCollector {
  /**
   * @param {object} opts
   * @param {string[]} opts.logGroups - Array of log group ARN or name strings
   * @param {string} opts.region - AWS region
   * @param {string} [opts.profile] - AWS profile name (uses fromIni if set)
   * @param {'live'|'phase'} opts.mode - Streaming mode
   * @param {Record<string, string>} opts.runtimeNames - Map of log group → runtime display name
   * @param {import('../broadcaster.js').Broadcaster} opts.broadcaster - Broadcaster instance
   * @param {boolean} [opts.verbose] - Enable verbose logging
   */
  constructor({ logGroups, region, profile, mode, runtimeNames, broadcaster, verbose }) {
    this.logGroups = logGroups || [];
    this.region = region;
    this.profile = profile;
    this.mode = mode || 'live';
    this.runtimeNames = runtimeNames || {};
    this.broadcaster = broadcaster;
    this.verbose = verbose || false;

    this.parser = new LogParser();
    this.client = null;
    this.running = false;
    this.sessionStartTime = null;
  }

  /**
   * Start streaming logs from CloudWatch LiveTail.
   */
  async start() {
    this.running = true;
    this.sessionStartTime = Date.now();
    await this._connect();
  }

  /**
   * Stop the LiveTail session and prevent reconnection.
   */
  stop() {
    this.running = false;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  /**
   * Get the number of minutes since the session started.
   * @returns {number} Minutes elapsed
   */
  getSessionMinutes() {
    if (!this.sessionStartTime) return 0;
    return (Date.now() - this.sessionStartTime) / 60000;
  }

  /**
   * Internal: establish connection and stream events.
   */
  async _connect() {
    if (!this.running) return;

    // Build client options
    const clientConfig = { region: this.region };
    if (this.profile) {
      clientConfig.credentials = fromIni({ profile: this.profile });
    }

    this.client = new CloudWatchLogsClient(clientConfig);

    try {
      const command = new StartLiveTailCommand({
        logGroupIdentifiers: this.logGroups,
      });

      const response = await this.client.send(command);

      for await (const event of response.responseStream) {
        if (!this.running) break;

        if (event.sessionStart) {
          if (this.verbose) {
            console.log('[CloudWatch] LiveTail session started');
          }
        }

        if (event.sessionUpdate) {
          const results = event.sessionUpdate.sessionResults || [];
          for (const logEvent of results) {
            this._handleLogEvent(logEvent);
          }
        }
      }

      // Stream ended naturally — reconnect if still running
      if (this.running) {
        if (this.verbose) {
          console.log('[CloudWatch] Stream ended, reconnecting...');
        }
        await this._scheduleReconnect();
      }
    } catch (err) {
      await this._handleError(err);
    }
  }

  /**
   * Internal: parse and broadcast a single log event.
   */
  _handleLogEvent(logEvent) {
    const logGroupId = logEvent.logGroupIdentifier || '';
    const runtimeName = this.runtimeNames[logGroupId] || this._inferRuntimeName(logGroupId);

    const parsed = this.parser.parse(logEvent, runtimeName);

    // In 'phase' mode, only broadcast phase, error, and invoke events
    if (this.mode === 'phase') {
      if (parsed.type !== 'phase' && parsed.type !== 'error' && parsed.type !== 'invoke') {
        return;
      }
    }

    // Broadcast the parsed event
    this.broadcaster.broadcast(parsed.type, parsed);
  }

  /**
   * Internal: infer runtime name from log group identifier.
   */
  _inferRuntimeName(logGroupId) {
    // Extract runtime name from log group path like /aws/bedrock-agentcore/runtimes/MyAgent-DEFAULT
    const match = logGroupId.match(/\/runtimes\/([^/]+?)(?:-DEFAULT)?$/);
    if (match) return match[1];
    return logGroupId.split('/').pop() || 'unknown';
  }

  /**
   * Internal: handle errors with appropriate recovery or messaging.
   */
  async _handleError(err) {
    const errorName = err.name || '';
    const errorMessage = err.message || '';

    // Credentials expired
    if (
      errorName === 'ExpiredTokenException' ||
      errorName === 'CredentialsProviderError' ||
      errorMessage.includes('expired') ||
      errorMessage.includes('security token')
    ) {
      const profileHint = this.profile ? this.profile : '<profile>';
      this.broadcaster.broadcast('error', {
        type: 'error',
        source: 'cloudwatch',
        level: 'ERROR',
        message: `AWS credentials expired. Run: aws sso login --profile ${profileHint}`,
        raw: errorMessage,
        metadata: {},
      });
      // Don't reconnect on auth errors — user must fix credentials
      this.running = false;
      return;
    }

    // Log group doesn't exist — warn but don't crash
    if (
      errorName === 'ResourceNotFoundException' ||
      errorMessage.includes('does not exist') ||
      errorMessage.includes('log group')
    ) {
      console.warn(`[CloudWatch] Log group not found: ${errorMessage}. Skipping.`);
      // Don't reconnect if log groups don't exist
      this.running = false;
      return;
    }

    // Any other error — log and attempt reconnect
    console.error(`[CloudWatch] Error: ${errorMessage}`);
    if (this.running) {
      await this._scheduleReconnect();
    }
  }

  /**
   * Internal: wait and reconnect.
   */
  async _scheduleReconnect() {
    if (!this.running) return;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    if (this.running) {
      // Destroy old client before reconnecting
      if (this.client) {
        this.client.destroy();
        this.client = null;
      }
      await this._connect();
    }
  }
}
