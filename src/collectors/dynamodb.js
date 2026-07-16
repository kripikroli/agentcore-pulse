/**
 * DynamoDB poller — periodically queries task state and emits changes.
 * Only activates if ACPULSE_TABLE_NAME is configured.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

const POLL_INTERVAL_MS = 3000;

export class DynamoDBCollector {
  /**
   * @param {object} opts
   * @param {string} opts.tableName - DynamoDB table name (e.g. 'btbs-task-ledger')
   * @param {string} [opts.region] - AWS region
   * @param {string} [opts.profile] - AWS profile name (uses fromIni)
   * @param {string} [opts.project] - Optional project filter
   * @param {import('../broadcaster.js').Broadcaster} opts.broadcaster - Broadcaster instance
   * @param {boolean} [opts.verbose] - Enable verbose logging
   */
  constructor({ tableName, region, profile, project, broadcaster, verbose }) {
    this.tableName = tableName;
    this.region = region || 'us-east-1';
    this.profile = profile;
    this.project = project;
    this.broadcaster = broadcaster;
    this.verbose = verbose || false;

    this.client = null;
    this.docClient = null;
    this.interval = null;
    this.previousHash = null;
  }

  /**
   * Start polling DynamoDB for task state changes.
   */
  start() {
    const clientConfig = { region: this.region };

    if (this.profile) {
      clientConfig.credentials = fromIni({ profile: this.profile });
    }

    this.client = new DynamoDBClient(clientConfig);
    this.docClient = DynamoDBDocumentClient.from(this.client, {
      marshallOptions: { removeUndefinedValues: true },
    });

    if (this.verbose) {
      console.log(`[dynamodb] Starting poller — table=${this.tableName}, region=${this.region}, project=${this.project || '(all)'}`);
    }

    // Initial poll immediately, then on interval
    this._poll();
    this.interval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  /**
   * Stop polling and release resources.
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.docClient = null;
    }
    if (this.verbose) {
      console.log('[dynamodb] Poller stopped');
    }
  }

  /**
   * Single poll cycle — queries DDB and broadcasts if state changed.
   * @private
   */
  async _poll() {
    try {
      const tasks = await this._queryActiveTasks();
      const queue = this.project ? await this._queryQueueState() : null;

      const currentState = { tasks, queue };
      const currentHash = JSON.stringify(currentState);

      // Only broadcast on changes
      if (currentHash !== this.previousHash) {
        this.previousHash = currentHash;

        this.broadcaster.broadcast('tasks', { tasks });

        if (queue) {
          this.broadcaster.broadcast('pipelines', {
            active: queue.activeIssues || [],
            waiting: queue.waitingIssues || [],
          });
        }

        if (this.verbose) {
          console.log(`[dynamodb] State changed — ${tasks.length} active task(s)`);
        }
      }
    } catch (err) {
      this._handleError(err);
    }
  }

  /**
   * Query GSI1 for all tasks with STATUS#IN_PROGRESS.
   * @private
   * @returns {Promise<Array>}
   */
  async _queryActiveTasks() {
    const params = {
      TableName: this.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :status',
      ExpressionAttributeValues: {
        ':status': 'STATUS#IN_PROGRESS',
      },
    };

    const result = await this.docClient.send(new QueryCommand(params));
    const items = result.Items || [];

    return items
      .map((item) => this._extractTaskFields(item))
      .filter((task) => {
        // If project filter is set, only include matching tasks
        if (this.project && task.projectId !== this.project) {
          return false;
        }
        return true;
      });
  }

  /**
   * Query queue state for the configured project.
   * @private
   * @returns {Promise<object|null>}
   */
  async _queryQueueState() {
    if (!this.project) return null;

    const params = {
      TableName: this.tableName,
      Key: {
        PK: `PROJECT#${this.project}`,
        SK: 'QUEUE',
      },
    };

    try {
      const result = await this.docClient.send(new GetCommand(params));
      return result.Item || { activeIssues: [], waitingIssues: [] };
    } catch (err) {
      if (this.verbose) {
        console.warn(`[dynamodb] Queue query failed: ${err.message}`);
      }
      return { activeIssues: [], waitingIssues: [] };
    }
  }

  /**
   * Extract normalized task fields from a DDB item.
   * PK format: PROJECT#{projectId}#ISSUE#{num}
   * SK format: TASK#001
   * @private
   */
  _extractTaskFields(item) {
    const pk = item.PK || '';
    const sk = item.SK || '';

    // Parse PK: PROJECT#{projectId}#ISSUE#{num}
    const pkMatch = pk.match(/^PROJECT#(.+?)#ISSUE#(\d+)$/);
    const projectId = pkMatch ? pkMatch[1] : null;
    const issueNumber = pkMatch ? parseInt(pkMatch[2], 10) : null;

    // Parse SK: TASK#001
    const skMatch = sk.match(/^TASK#(\d+)$/);
    const sequence = skMatch ? parseInt(skMatch[1], 10) : null;

    return {
      projectId,
      issueNumber,
      sequence,
      status: item.status || item.Status || 'UNKNOWN',
      taskId: item.taskId || `${pk}|${sk}`,
      branchName: item.branchName || item.BranchName || null,
      prNumber: item.prNumber || item.PRNumber || null,
    };
  }

  /**
   * Handle polling errors with appropriate responses.
   * @private
   */
  _handleError(err) {
    const name = err.name || err.constructor?.name || '';
    const message = err.message || String(err);

    if (name === 'ResourceNotFoundException' || message.includes('resource not found') || message.includes('table') && message.includes('not found')) {
      console.error(`[dynamodb] Table "${this.tableName}" not found. Stopping poller.`);
      this.broadcaster.broadcast('error', {
        source: 'dynamodb',
        message: `Table "${this.tableName}" not found. Check ACPULSE_TABLE_NAME configuration.`,
      });
      this.stop();
    } else if (name === 'AccessDeniedException' || message.includes('AccessDenied') || message.includes('not authorized')) {
      console.error(`[dynamodb] Access denied querying table "${this.tableName}".`);
      this.broadcaster.broadcast('error', {
        source: 'dynamodb',
        message: `Access denied to table "${this.tableName}". Ensure your IAM role/profile has dynamodb:Query and dynamodb:GetItem permissions.`,
      });
      this.stop();
    } else {
      if (this.verbose) {
        console.warn(`[dynamodb] Poll error (will retry): ${message}`);
      }
      // Continue polling — transient errors will resolve
    }
  }
}
