/**
 * Configuration builder — merges CLI args > dashboard/.env > defaults.
 * @module config
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

/**
 * @typedef {Object} PulseConfig
 * @property {string} mode - 'live' or 'phase'
 * @property {number} port
 * @property {string} profile - AWS profile name
 * @property {string} region - AWS region
 * @property {string} [project] - Filter to project
 * @property {string} [runtime] - Filter to runtime
 * @property {string} [tableName] - DynamoDB table
 * @property {boolean} verbose
 * @property {Object} panels - Panel enable/disable flags
 */

/**
 * Build configuration from CLI options + dashboard/.env + defaults.
 * @param {Object} opts - Commander parsed options
 * @returns {PulseConfig}
 */
export function buildConfig(opts) {
  // Load dashboard/.env if it exists
  const envPath = resolve(process.cwd(), 'dashboard', '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  const env = process.env;

  return {
    mode: opts.mode || 'live',
    port: parseInt(opts.port || env.ACPULSE_PORT || '3141', 10),
    profile: opts.profile || env.ACPULSE_AWS_PROFILE || '',
    region: env.ACPULSE_AWS_REGION || 'us-east-1',
    project: opts.project || undefined,
    runtime: opts.runtime || undefined,
    tableName: env.ACPULSE_TABLE_NAME || '',
    verbose: opts.verbose || false,
    panels: {
      pipelines: opts.pipelines !== false,
      kiro: opts.kiro !== false,
      timeline: opts.timeline !== false,
      tasks: opts.tasks !== false,
      supervisor: opts.supervisor !== false,
      errors: opts.errors !== false,
      history: opts.history !== false,
    },
  };
}
