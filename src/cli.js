#!/usr/bin/env node
/**
 * agentcore-pulse — Real-time observability dashboard for AgentCore.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { buildConfig } from './config.js';

const program = new Command();

program
  .name('agentcore-pulse')
  .description('Real-time observability dashboard for Amazon Bedrock AgentCore')
  .version('0.1.0');

// Default command — start the dashboard
program
  .option('--mode <mode>', 'Streaming mode: live (all logs) or phase (structured events only)', 'live')
  .option('--port <number>', 'Dashboard port', '3141')
  .option('--profile <name>', 'AWS profile name', '')
  .option('--project <id>', 'Filter to specific project')
  .option('--runtime <name>', 'Filter to specific runtime')
  .option('--no-pipelines', 'Disable pipelines panel')
  .option('--no-kiro', 'Disable kiro/logs panel')
  .option('--no-timeline', 'Disable timeline panel')
  .option('--no-tasks', 'Disable tasks panel')
  .option('--no-supervisor', 'Disable supervisor panel')
  .option('--no-errors', 'Disable errors panel')
  .option('--no-history', 'Disable history panel')
  .option('--verbose', 'Log raw AWS API calls and broadcast events to terminal')
  .action(async (opts) => {
    const config = buildConfig(opts);

    // Startup banner
    console.log('');
    console.log('  ⚡ agentcore-pulse v0.1.0');
    console.log(`  Mode: ${config.mode} | Port: ${config.port}`);
    console.log(`  Profile: ${config.profile || 'default'}`);
    console.log('');

    const { Orchestrator } = await import('./orchestrator.js');
    const { startServer } = await import('./server.js');

    const orchestrator = new Orchestrator(config);
    await startServer(config, orchestrator);
    await orchestrator.start();
  });

// Init subcommand
program
  .command('init')
  .description('Create dashboard/ folder with .env template and pattern config')
  .action(() => {
    const dashDir = resolve(process.cwd(), 'dashboard');

    if (existsSync(dashDir)) {
      console.log('  ⚠️  dashboard/ folder already exists. Skipping.');
      return;
    }

    mkdirSync(dashDir, { recursive: true });

    // .env template
    writeFileSync(resolve(dashDir, '.env'), [
      '# agentcore-pulse configuration',
      '# These values override CLI defaults when running from this project.',
      '',
      '# AWS profile for CloudWatch and DynamoDB access',
      'ACPULSE_AWS_PROFILE=',
      '',
      '# AWS region (default: us-east-1)',
      'ACPULSE_AWS_REGION=us-east-1',
      '',
      '# DynamoDB table name (enables tasks/pipelines panels)',
      '# Leave empty if your project does not use DynamoDB for state.',
      'ACPULSE_TABLE_NAME=',
      '',
      '# Dashboard port (default: 3141)',
      'ACPULSE_PORT=3141',
      '',
    ].join('\n'));

    // .patterns.json
    writeFileSync(resolve(dashDir, '.patterns.json'), JSON.stringify({
      phases: ['Phase started: (.+)', 'Phase completed: (.+)', 'Pipeline completed', 'Pipeline failed'],
      invocations: ['invokeViaGateway', 'invoke_kiro', 'Invoking kiro-cli', 'invoke-agent-runtime'],
      errors: ['ERROR', 'Error', 'failed', 'Exception', 'FATAL'],
      supervisor: ['tool_call', 'getProjectConfig', 'invokeKiroHarness', 'invokeProductAgent', 'putTaskRecord', 'updateTaskStatus'],
    }, null, 2) + '\n');

    // .gitignore for dashboard folder
    writeFileSync(resolve(dashDir, '.gitignore'), '.env\n');

    console.log('  ✅ Created dashboard/ folder with:');
    console.log('     • .env (configure AWS profile, region, table)');
    console.log('     • .patterns.json (custom log patterns)');
    console.log('     • .gitignore (ignores .env)');
    console.log('');
    console.log('  Next: edit dashboard/.env, then run `agentcore-pulse --mode=live`');
  });

program.parse();
