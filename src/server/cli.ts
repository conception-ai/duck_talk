/**
 * CLI entry point.
 * Parses args, loads .env, checks prerequisites, starts Express server.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type ServerConfig } from './routes.js';
import type { ClaudeConfig } from './claude-client.js';

// --- .env loader (no deps) ---

function loadEnv(): void {
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1]!.trim();
        if (!process.env[key]) process.env[key] = match[2]!.trim();
      }
    }
  } catch {
    // no .env file
  }
}

// --- Arg parsing ---

function parseArgs(argv: string[]): { port: number; host: string; noBrowser: boolean } {
  let port = 8000;
  let host = '127.0.0.1';
  let noBrowser = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i]!, 10);
    } else if (arg === '--host' && argv[i + 1]) {
      host = argv[++i]!;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    }
  }

  return { port, host, noBrowser };
}

// --- Prerequisites ---

function checkPrereqs(config: ClaudeConfig): void {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.warn('Warning: ANTHROPIC_API_KEY not set. Claude may use other auth methods.');
  }

  const cliPath = config.cliPath || 'claude';
  try {
    execSync(`which ${cliPath}`, { stdio: 'ignore' });
  } catch {
    console.error(`Error: '${cliPath}' not found on PATH.`);
    console.error('Install Claude Code: npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  }
}

// --- Main ---

loadEnv();

const { port, host, noBrowser } = parseArgs(process.argv);

const claudeConfig: ClaudeConfig = {
  configDir: process.env['CLAUDE_CONFIG_DIR'] || '~/.claude',
  cliPath: process.env['CLAUDE_CLI_PATH'],
};

checkPrereqs(claudeConfig);

// Resolve built frontend: works from both src/server/ (dev) and dist/server/ (prod)
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'dist', 'public');

const serverConfig: ServerConfig = {
  claude: claudeConfig,
  cwd: process.cwd(),
  publicDir: existsSync(publicDir) ? publicDir : undefined,
};

const app = createApp(serverConfig);

app.listen(port, host, () => {
  console.info(`Reduck listening on http://${host}:${port}`);
  console.info(`Project: ${serverConfig.cwd}`);
  if (serverConfig.publicDir) {
    console.info('Serving frontend from dist/public/');
  } else {
    console.info('No built frontend found — run "npm run build" first, or use Vite dev server');
  }

  if (!noBrowser) {
    setTimeout(() => {
      const url = `http://localhost:${port}`;
      try {
        execSync(`open ${url}`, { stdio: 'ignore' });
      } catch {
        // open not available on all platforms
      }
    }, 1500);
  }
});
