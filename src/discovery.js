/**
 * Auto-discovery — reads agentcore config files from cwd to find runtimes and derive log groups.
 * @module discovery
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * @typedef {Object} DiscoveredRuntime
 * @property {string} name - Runtime name (e.g. 'SupervisorAgent')
 * @property {string} runtimeId - Deployed runtime ID
 * @property {string} runtimeArn - Full ARN
 * @property {string} logGroup - Derived CloudWatch log group
 * @property {string} build - 'CodeZip' or 'Container'
 */

/**
 * @typedef {Object} DiscoveryResult
 * @property {DiscoveredRuntime[]} runtimes
 * @property {Object|null} gateway - Gateway info if available
 * @property {string} projectName - AgentCore project name
 * @property {string} region - AWS region from config
 * @property {string[]} warnings - Non-fatal issues
 */

/**
 * Discover AgentCore runtimes from local config files.
 * @param {string} [cwd] - Working directory to search from
 * @returns {DiscoveryResult}
 */
export function discover(cwd = process.cwd()) {
  const warnings = [];
  const result = {
    runtimes: [],
    gateway: null,
    projectName: '',
    region: 'us-east-1',
    warnings,
  };

  // Read agentcore.json
  const agentcorePath = resolve(cwd, 'agentcore', 'agentcore.json');
  if (!existsSync(agentcorePath)) {
    warnings.push(`No agentcore/agentcore.json found in ${cwd}. Run this inside an AgentCore project.`);
    return result;
  }

  let agentcoreConfig;
  try {
    agentcoreConfig = JSON.parse(readFileSync(agentcorePath, 'utf-8'));
  } catch (e) {
    warnings.push(`Failed to parse agentcore/agentcore.json: ${e.message}`);
    return result;
  }

  result.projectName = agentcoreConfig.name || 'unknown';

  // Read deployed-state.json
  const statePath = resolve(cwd, 'agentcore', '.cli', 'deployed-state.json');
  let deployedState = null;
  if (existsSync(statePath)) {
    try {
      deployedState = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch (e) {
      warnings.push(`Failed to parse deployed-state.json: ${e.message}`);
    }
  } else {
    warnings.push('No agentcore/.cli/deployed-state.json found. Run `agentcore deploy` first.');
  }

  // Extract runtimes
  const runtimeConfigs = agentcoreConfig.runtimes || [];
  const deployedRuntimes = deployedState?.targets?.production?.resources?.runtimes || {};

  for (const rt of runtimeConfigs) {
    const deployed = deployedRuntimes[rt.name];
    const runtimeId = deployed?.runtimeId || '';
    const runtimeArn = deployed?.runtimeArn || '';
    const logGroup = runtimeId
      ? `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`
      : '';

    result.runtimes.push({
      name: rt.name,
      runtimeId,
      runtimeArn,
      logGroup,
      build: rt.build || 'CodeZip',
    });

    if (!runtimeId) {
      warnings.push(`Runtime "${rt.name}" has no deployed ID. It won't be monitored.`);
    }
  }

  // Extract gateway info
  const deployedGateways = deployedState?.targets?.production?.resources?.gateways || {};
  const gatewayConfigs = agentcoreConfig.agentCoreGateways || [];
  if (gatewayConfigs.length > 0 && Object.keys(deployedGateways).length > 0) {
    const gwName = gatewayConfigs[0].name;
    const gwDeployed = deployedGateways[gwName];
    if (gwDeployed) {
      result.gateway = {
        name: gwName,
        url: gwDeployed.gatewayUrl || '',
        targets: gwDeployed.targets || {},
      };
    }
  }

  // Derive region from deployed ARN
  if (result.runtimes.length > 0 && result.runtimes[0].runtimeArn) {
    const arnParts = result.runtimes[0].runtimeArn.split(':');
    if (arnParts.length >= 4) {
      result.region = arnParts[3];
    }
  }

  return result;
}
