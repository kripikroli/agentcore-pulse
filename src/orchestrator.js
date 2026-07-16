/**
 * Orchestrator — wires collectors to the broadcaster based on config.
 * Central coordination point that manages lifecycle of all data collectors.
 * @module orchestrator
 */
import { CloudWatchCollector } from './collectors/cloudwatch.js';
import { DynamoDBCollector } from './collectors/dynamodb.js';
import { HistoryCollector, createHistoryRoute } from './collectors/history.js';
import { discover } from './discovery.js';
import { Broadcaster } from './broadcaster.js';

export class Orchestrator {
  /**
   * @param {import('./config.js').PulseConfig} config
   */
  constructor(config) {
    this.config = config;
    this.broadcaster = new Broadcaster();
    this.discovery = null;
    this.cloudwatch = null;
    this.dynamodb = null;
    this.history = null;
    this.costInterval = null;
    this._historyRoute = null;
  }

  /**
   * Run auto-discovery and log results.
   * Safe to call multiple times — caches the result.
   * @returns {import('./discovery.js').DiscoveryResult}
   */
  getDiscovery() {
    if (!this.discovery) {
      this.discovery = discover();
    }
    return this.discovery;
  }

  /**
   * Get the WebSocket broadcaster instance.
   * @returns {Broadcaster}
   */
  getBroadcaster() {
    return this.broadcaster;
  }

  /**
   * Get the /api/history Express route handler.
   * Lazily creates the HistoryCollector if not yet initialized.
   * @returns {Function} Express route handler
   */
  getHistoryRoute() {
    if (!this._historyRoute) {
      this._ensureHistoryCollector();
      this._historyRoute = createHistoryRoute(this.history);
    }
    return this._historyRoute;
  }

  /**
   * Start all collectors based on panel config and discovered runtimes.
   * Handles errors gracefully — individual collector failures don't crash the system.
   */
  async start() {
    const { config } = this;
    const { panels } = config;
    const discovery = this.getDiscovery();
    const { runtimes } = discovery;

    // --- Credential pre-check ---
    const credsValid = await this._validateCredentials();
    if (!credsValid) {
      const profileHint = config.profile || '<profile>';
      console.error(`\n  ❌ AWS credentials are invalid or expired.`);
      console.error(`     Run: aws sso login --profile ${profileHint}\n`);
      console.error(`     Dashboard running in offline mode (no live data).\n`);
      this.broadcaster.broadcast('error', {
        source: 'orchestrator',
        message: `AWS credentials expired. Run: aws sso login --profile ${profileHint}`,
      });
      // Start history in session-only mode so dashboard doesn't appear broken
      this._ensureHistoryCollector();
      return;
    }

    // --- CloudWatch Collector ---
    const needsCloudWatch = panels.kiro || panels.supervisor || panels.errors || panels.pipelines;
    const deployedRuntimes = runtimes.filter((rt) => rt.logGroup);

    if (needsCloudWatch && deployedRuntimes.length > 0) {
      try {
        const logGroups = this._buildLogGroups(deployedRuntimes);
        const runtimeNames = this._buildRuntimeNames(deployedRuntimes);

        if (logGroups.length > 0) {
          this.cloudwatch = new CloudWatchCollector({
            logGroups,
            region: discovery.region || config.region,
            profile: config.profile || undefined,
            mode: config.mode,
            runtimeNames,
            broadcaster: this.broadcaster,
            verbose: config.verbose,
          });

          await this.cloudwatch.start();
          this._log('CloudWatch LiveTail started');

          // Start cost broadcast interval (every 30s)
          this.costInterval = setInterval(() => {
            if (this.cloudwatch) {
              this.broadcaster.broadcast('cost', {
                minutes: Math.round(this.cloudwatch.getSessionMinutes() * 100) / 100,
              });
            }
          }, 30_000);
        }
      } catch (err) {
        this._warn(`CloudWatch collector failed to start: ${err.message}`);
        this.broadcaster.broadcast('error', {
          source: 'orchestrator',
          message: `CloudWatch failed: ${err.message}`,
        });
      }
    } else if (needsCloudWatch && deployedRuntimes.length === 0) {
      this._warn('No deployed runtimes with log groups found. CloudWatch streaming disabled.');
    }

    // --- DynamoDB Collector ---
    const needsDynamoDB = panels.tasks || panels.pipelines;

    if (needsDynamoDB && config.tableName) {
      try {
        this.dynamodb = new DynamoDBCollector({
          tableName: config.tableName,
          region: discovery.region || config.region,
          profile: config.profile || undefined,
          project: config.project || discovery.projectName || undefined,
          broadcaster: this.broadcaster,
          verbose: config.verbose,
        });

        this.dynamodb.start();
        this._log('DynamoDB poller started');
      } catch (err) {
        this._warn(`DynamoDB collector failed to start: ${err.message}`);
        this.broadcaster.broadcast('error', {
          source: 'orchestrator',
          message: `DynamoDB failed: ${err.message}`,
        });
      }
    } else if (needsDynamoDB && !config.tableName) {
      this._warn('No ACPULSE_TABLE_NAME configured. Tasks/pipelines panels disabled.');
    }

    // --- History Collector ---
    this._ensureHistoryCollector();
    if (panels.history) {
      try {
        await this.history.start();
        this._log('History collector started');
      } catch (err) {
        this._warn(`History collector failed to start: ${err.message}`);
      }
    }

    // --- Wire CloudWatch events → History session events ---
    if (this.cloudwatch && this.history) {
      const originalBroadcast = this.broadcaster.broadcast.bind(this.broadcaster);
      this.broadcaster.broadcast = (type, data) => {
        // Forward relevant events to history collector
        if (type === 'phase' || type === 'error' || type === 'invoke') {
          this.history.addSessionEvent({
            type,
            source: data.source || 'unknown',
            message: data.message || '',
          });
        }

        // Verbose logging
        if (this.config.verbose) {
          const size = JSON.stringify(data).length;
          console.log(`[broadcast] ${type} (${size} bytes) → ${this.broadcaster.count} client(s)`);
        }

        originalBroadcast(type, data);
      };
    } else if (this.config.verbose) {
      // Verbose logging without history wiring
      const originalBroadcast = this.broadcaster.broadcast.bind(this.broadcaster);
      this.broadcaster.broadcast = (type, data) => {
        const size = JSON.stringify(data).length;
        console.log(`[broadcast] ${type} (${size} bytes) → ${this.broadcaster.count} client(s)`);
        originalBroadcast(type, data);
      };
    }
  }

  /**
   * Gracefully stop all collectors and release resources.
   */
  async stop() {
    if (this.costInterval) {
      clearInterval(this.costInterval);
      this.costInterval = null;
    }

    if (this.cloudwatch) {
      this.cloudwatch.stop();
      this.cloudwatch = null;
      this._log('CloudWatch collector stopped');
    }

    if (this.dynamodb) {
      this.dynamodb.stop();
      this.dynamodb = null;
      this._log('DynamoDB collector stopped');
    }

    if (this.history) {
      this.history.stop();
      this.history = null;
      this._log('History collector stopped');
    }
  }

  // --- Private Helpers ---

  /**
   * Validate AWS credentials before starting collectors.
   * Uses STS GetCallerIdentity as a lightweight check.
   * @returns {Promise<boolean>} true if credentials are valid
   */
  async _validateCredentials() {
    try {
      const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
      const { fromIni } = await import('@aws-sdk/credential-providers');

      const clientConfig = { region: this.config.region || 'us-east-1' };
      if (this.config.profile) {
        clientConfig.credentials = fromIni({ profile: this.config.profile });
      }

      const sts = new STSClient(clientConfig);
      await sts.send(new GetCallerIdentityCommand({}));
      sts.destroy();
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Build log groups array, filtered by --runtime if specified.
   * @param {Array} deployedRuntimes - Runtimes with logGroup set
   * @returns {string[]}
   */
  _buildLogGroups(deployedRuntimes) {
    let filtered = deployedRuntimes;

    if (this.config.runtime) {
      filtered = deployedRuntimes.filter(
        (rt) => rt.name.toLowerCase() === this.config.runtime.toLowerCase()
      );
      if (filtered.length === 0) {
        this._warn(
          `Runtime "${this.config.runtime}" not found. Available: ${deployedRuntimes.map((r) => r.name).join(', ')}`
        );
      }
    }

    return filtered.map((rt) => rt.logGroup).filter(Boolean);
  }

  /**
   * Build runtimeNames map (logGroup → display name).
   * @param {Array} deployedRuntimes
   * @returns {Record<string, string>}
   */
  _buildRuntimeNames(deployedRuntimes) {
    const map = {};
    for (const rt of deployedRuntimes) {
      if (rt.logGroup) {
        map[rt.logGroup] = rt.name;
      }
    }
    return map;
  }

  /**
   * Ensure the HistoryCollector is created (lazy init).
   */
  _ensureHistoryCollector() {
    if (!this.history) {
      this.history = new HistoryCollector({
        tableName: this.config.tableName || undefined,
        region: this.discovery?.region || this.config.region,
        profile: this.config.profile || undefined,
        broadcaster: this.broadcaster,
        verbose: this.config.verbose,
      });
    }
  }

  /**
   * Log a verbose message.
   * @param {string} msg
   */
  _log(msg) {
    if (this.config.verbose) {
      console.log(`[orchestrator] ${msg}`);
    }
  }

  /**
   * Log a warning (always visible).
   * @param {string} msg
   */
  _warn(msg) {
    console.warn(`  ⚠️  ${msg}`);
  }
}
