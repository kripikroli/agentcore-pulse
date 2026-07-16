/**
 * Express + WebSocket server for agentcore-pulse dashboard.
 * Accepts an Orchestrator instance that provides discovery, broadcaster, and routes.
 * @module server
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Start the Express + WebSocket server.
 * @param {import('./config.js').PulseConfig} config
 * @param {import('./orchestrator.js').Orchestrator} orchestrator
 */
export async function startServer(config, orchestrator) {
  const discovery = orchestrator.getDiscovery();
  const broadcaster = orchestrator.getBroadcaster();
  const { runtimes, gateway, projectName, warnings } = discovery;

  // --- Print discovery results ---
  console.log(`  📡 Project: ${projectName || '(unknown)'}`);
  if (runtimes.length > 0) {
    console.log(`  🔍 Discovered ${runtimes.length} runtime(s):`);
    for (const rt of runtimes) {
      const status = rt.runtimeId ? '✓' : '✗';
      console.log(`     ${status} ${rt.name} [${rt.build}]${rt.runtimeId ? ` → ${rt.runtimeId}` : ' (not deployed)'}`);
    }
  } else {
    console.log('  ⚠️  No runtimes discovered.');
  }
  if (gateway) {
    console.log(`  🌐 Gateway: ${gateway.name}`);
  }
  if (warnings.length > 0 && config.verbose) {
    console.log('  ⚠️  Warnings:');
    for (const w of warnings) {
      console.log(`     • ${w}`);
    }
  }
  console.log('');

  // --- Express App ---
  const app = express();
  const publicDir = resolve(__dirname, '..', 'public');

  // API endpoint — returns discovered runtimes and panel config
  app.get('/api/config', (_req, res) => {
    res.json({
      runtimes,
      panels: config.panels,
      mode: config.mode,
      gateway: gateway || null,
      projectName,
    });
  });

  // History API endpoint
  app.get('/api/history', orchestrator.getHistoryRoute());

  // Static files from public/
  app.use(express.static(publicDir));

  // Fallback — serve index.html for root
  app.get('/', (_req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  // --- HTTP Server ---
  const server = createServer(app);

  // --- WebSocket Server ---
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests — only for /ws path
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle WebSocket connections
  wss.on('connection', (ws) => {
    broadcaster.add(ws);

    // Send initial config message
    ws.send(JSON.stringify({
      type: 'config',
      data: {
        runtimes,
        panels: config.panels,
        mode: config.mode,
        gateway: gateway || null,
      },
    }));

    ws.on('close', () => {
      broadcaster.remove(ws);
    });

    ws.on('error', () => {
      broadcaster.remove(ws);
    });
  });

  // --- Start Listening ---
  const { port } = config;

  await new Promise((resolvePromise) => {
    server.listen(port, () => {
      resolvePromise();
    });
  });

  const url = `http://localhost:${port}`;
  console.log(`  🚀 Dashboard running at ${url}`);
  console.log(`  🔌 WebSocket endpoint: ws://localhost:${port}/ws`);
  console.log(`  📊 Panels: ${Object.entries(config.panels).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.\n');

  // Auto-open browser
  try {
    await open(url);
  } catch {
    // Silently ignore if browser can't be opened (e.g., headless env)
  }

  // --- Graceful Shutdown ---
  const shutdown = async () => {
    console.log('\n  🛑 Shutting down...');

    // Stop all collectors first
    await orchestrator.stop();

    // Close all WebSocket connections
    for (const ws of broadcaster.clients) {
      ws.close(1001, 'Server shutting down');
    }

    // Close WebSocket server
    wss.close();

    // Close HTTP server
    server.close(() => {
      console.log('  ✅ Server stopped.\n');
      process.exit(0);
    });

    // Force exit after 3 seconds if graceful close hangs
    setTimeout(() => {
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, wss, broadcaster, discovery };
}
