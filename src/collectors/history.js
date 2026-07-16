/**
 * History collector — queries past AEW executions from DynamoDB and provides REST endpoint.
 * Also accumulates events from the current session as fallback.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

/**
 * Collects and serves historical task execution data.
 * Primary source: DynamoDB task ledger (GSI1 by status).
 * Fallback: in-memory session events accumulated during dashboard lifetime.
 */
export class HistoryCollector {
  /**
   * @param {object} opts
   * @param {string} [opts.tableName] - DynamoDB table name (omit for session-only mode)
   * @param {string} [opts.region] - AWS region (default: us-east-1)
   * @param {string} [opts.profile] - AWS CLI profile name for credentials
   * @param {object} [opts.broadcaster] - WebSocket broadcaster with .broadcast(channel, data)
   * @param {boolean} [opts.verbose] - Enable verbose logging
   */
  constructor({ tableName, region, profile, broadcaster, verbose } = {}) {
    this.tableName = tableName || null;
    this.region = region || 'us-east-1';
    this.profile = profile || null;
    this.broadcaster = broadcaster || null;
    this.verbose = verbose || false;

    this.ddbClient = null;
    this.docClient = null;
    this.refreshInterval = null;
    this.historyCache = [];
    this.sessionEvents = [];
    this.sessionMode = !this.tableName;
  }

  /**
   * Start the history collector.
   * If tableName is configured, queries DynamoDB for recent completed/failed tasks.
   * Sets up a 60-second refresh interval.
   */
  async start() {
    if (this.sessionMode) {
      this._log('No DynamoDB table configured — running in session-only mode');
      if (this.broadcaster) {
        this.broadcaster.broadcast('history', { records: [] });
      }
      return;
    }

    try {
      this._initDDBClient();
      await this._fetchHistory();
    } catch (err) {
      if (err.name === 'AccessDeniedException' || err.name === 'UnrecognizedClientException') {
        this._warn(`DynamoDB access denied: ${err.message}. Falling back to session mode.`);
        this.sessionMode = true;
        this._destroyDDBClient();
        if (this.broadcaster) {
          this.broadcaster.broadcast('history', { records: [] });
        }
        return;
      }
      this._warn(`Failed to fetch initial history: ${err.message}. Will serve stale cache.`);
    }

    // Broadcast initial history
    if (this.broadcaster) {
      this.broadcaster.broadcast('history', { records: this.historyCache });
    }

    // Refresh every 60 seconds
    this.refreshInterval = setInterval(async () => {
      try {
        await this._fetchHistory();
        if (this.broadcaster) {
          this.broadcaster.broadcast('history', { records: this.historyCache });
        }
      } catch (err) {
        this._warn(`History refresh failed: ${err.message}. Serving stale cache.`);
      }
    }, 60_000);
  }

  /**
   * Add a session event (fallback when DynamoDB is not configured).
   * @param {object} event - Event data with at least { type, source, message }
   */
  addSessionEvent(event) {
    const record = {
      ts: new Date().toISOString(),
      type: event.type || 'unknown',
      source: event.source || 'dashboard',
      message: event.message || '',
      ...event,
    };
    this.sessionEvents.push(record);

    // Keep last 200 events
    if (this.sessionEvents.length > 200) {
      this.sessionEvents = this.sessionEvents.slice(-200);
    }
  }

  /**
   * Get paginated history records.
   * @param {number} [limit=20] - Max records to return
   * @param {number} [offset=0] - Number of records to skip
   * @returns {{ records: Array, total: number, hasMore: boolean }}
   */
  getHistory(limit = 20, offset = 0) {
    const source = this.sessionMode ? this.sessionEvents : this.historyCache;
    const total = source.length;
    const records = source.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    return { records, total, hasMore };
  }

  /**
   * Stop the history collector. Clears refresh interval and destroys DDB client.
   */
  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this._destroyDDBClient();
  }

  // --- Private methods ---

  /**
   * Initialize the DynamoDB Document client.
   */
  _initDDBClient() {
    const clientConfig = { region: this.region };
    if (this.profile) {
      clientConfig.credentials = fromIni({ profile: this.profile });
    }
    this.ddbClient = new DynamoDBClient(clientConfig);
    this.docClient = DynamoDBDocumentClient.from(this.ddbClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  /**
   * Destroy the DDB client and release resources.
   */
  _destroyDDBClient() {
    if (this.ddbClient) {
      this.ddbClient.destroy();
      this.ddbClient = null;
      this.docClient = null;
    }
  }

  /**
   * Fetch history from DynamoDB GSI1 for MERGED and FAILED statuses.
   */
  async _fetchHistory() {
    const [merged, failed] = await Promise.all([
      this._queryByStatus('STATUS#MERGED', 30),
      this._queryByStatus('STATUS#FAILED', 20),
    ]);

    // Combine and sort by updatedAt descending
    const combined = [...merged, ...failed];
    combined.sort((a, b) => {
      const dateA = a.updatedAt || a.completedAt || '';
      const dateB = b.updatedAt || b.completedAt || '';
      return dateB.localeCompare(dateA);
    });

    // Map to history records
    this.historyCache = combined.map((item) => this._mapToHistoryRecord(item));
    this._log(`Fetched ${this.historyCache.length} history records (${merged.length} merged, ${failed.length} failed)`);
  }

  /**
   * Query GSI1 for tasks with a specific status.
   * @param {string} statusKey - GSI1PK value (e.g., 'STATUS#MERGED')
   * @param {number} limit - Max items to return
   * @returns {Promise<Array>} Raw DynamoDB items
   */
  async _queryByStatus(statusKey, limit) {
    try {
      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': statusKey },
        Limit: limit,
        ScanIndexForward: false, // newest first
      });
      const result = await this.docClient.send(command);
      return result.Items || [];
    } catch (err) {
      // Re-throw access errors so start() can catch and switch to session mode
      if (err.name === 'AccessDeniedException' || err.name === 'UnrecognizedClientException') {
        throw err;
      }
      this._warn(`Query for ${statusKey} failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Map a raw DynamoDB item to a normalized history record.
   * @param {object} item - DynamoDB item
   * @returns {object} Normalized history record
   */
  _mapToHistoryRecord(item) {
    return {
      id: item.SK || item.PK || item.id || null,
      projectId: item.projectId || this._extractProjectId(item.PK),
      issueNumber: item.issueNumber || null,
      sequence: item.sequence ?? null,
      status: item.status || this._extractStatus(item.GSI1PK),
      prNumber: item.prNumber || null,
      prUrl: item.prUrl || null,
      branchName: item.branchName || null,
      duration: item.duration || null,
      completedAt: item.updatedAt || item.completedAt || null,
    };
  }

  /**
   * Extract project ID from a PK like 'PROJECT#my-project'.
   * @param {string} pk
   * @returns {string|null}
   */
  _extractProjectId(pk) {
    if (!pk) return null;
    const parts = pk.split('#');
    return parts.length > 1 ? parts[1] : pk;
  }

  /**
   * Extract status from a GSI1PK like 'STATUS#MERGED'.
   * @param {string} gsi1pk
   * @returns {string|null}
   */
  _extractStatus(gsi1pk) {
    if (!gsi1pk) return null;
    const parts = gsi1pk.split('#');
    return parts.length > 1 ? parts[1] : gsi1pk;
  }

  /**
   * Log a verbose message.
   * @param {string} msg
   */
  _log(msg) {
    if (this.verbose) {
      console.log(`[history] ${msg}`);
    }
  }

  /**
   * Log a warning.
   * @param {string} msg
   */
  _warn(msg) {
    console.warn(`[history] ⚠ ${msg}`);
  }
}

/**
 * Create the /api/history Express route handler.
 * @param {HistoryCollector} collector
 * @returns {Function} Express route handler
 */
export function createHistoryRoute(collector) {
  return (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const result = collector.getHistory(limit, offset);
    res.json(result);
  };
}
