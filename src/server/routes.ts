/**
 * Express routes — port of Python server.py.
 * SSE streaming, session listing, tree navigation.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import {
  Conversation,
  forkSession,
  pathToSlug,
  preview,
  sessionPreview,
} from '../shared/models.js';
import { isUserEntry, isAssistantEntry } from '../shared/types.js';
import type { ContentBlock } from '../shared/types.js';
import { Claude, type ClaudeConfig } from './claude-client.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

// --- App factory ---

export interface ServerConfig {
  claude: ClaudeConfig;
  cwd: string;
}

export function createApp(cfg: ServerConfig): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const claude = new Claude(cfg.claude);
  const PROJECT_CWD = cfg.cwd;
  const PROJECT_SLUG = pathToSlug(PROJECT_CWD);

  function projectDirPath(): string {
    const expanded = cfg.claude.configDir.replace(/^~/, process.env['HOME'] || '');
    return join(expanded, 'projects', PROJECT_SLUG);
  }

  function findSessionFile(sessionId: string): string | null {
    const candidate = join(projectDirPath(), `${sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : null;
  }

  function loadConversation(sessionId: string): Conversation {
    const path = findSessionFile(sessionId);
    if (!path) {
      throw { status: 404, message: `Session not found: ${sessionId}` };
    }
    return Conversation.fromJsonl(path);
  }

  // --- GET /api/config ---

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({ config_dir: cfg.claude.configDir, project_cwd: PROJECT_CWD });
  });

  // --- GET /api/sessions ---

  app.get('/api/sessions', (_req: Request, res: Response) => {
    const pdir = projectDirPath();
    if (!existsSync(pdir)) {
      res.json([]);
      return;
    }

    const files = readdirSync(pdir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(pdir, f));

    const previews: { file: string; name: string; summary: string; timestamp: string }[] = [];
    const seen = new Set<string>();

    for (const f of files) {
      const sid = basename(f, '.jsonl');
      if (seen.has(sid)) continue;
      seen.add(sid);
      const { name, summary, timestamp } = sessionPreview(f);
      if (name) {
        previews.push({ file: f, name, summary, timestamp });
      }
    }

    previews.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));

    res.json(
      previews.map((p) => ({
        id: basename(p.file, '.jsonl'),
        name: p.name,
        summary: p.summary,
        updated_at: p.timestamp,
      })),
    );
  });

  // --- GET /api/sessions/:id/leaves ---

  app.get('/api/sessions/:id/leaves', (req: Request, res: Response) => {
    try {
      const conv = loadConversation(req.params['id'] as string);
      const active = conv.activeLeaf;
      const activeUuid = active?.uuid ?? null;

      const result = conv.leaves.map((leaf) => ({
        uuid: leaf.uuid,
        type: leaf.type,
        depth: conv.walkPath(leaf.uuid).length,
        preview: preview(leaf),
        is_active: leaf.uuid === activeUuid,
      }));

      result.sort((a, b) => b.depth - a.depth);
      res.json(result);
    } catch (e) {
      handleError(res, e);
    }
  });

  // --- GET /api/sessions/:id/path ---

  app.get('/api/sessions/:id/path', (req: Request, res: Response) => {
    try {
      const conv = loadConversation(req.params['id'] as string);
      const leafParam = req.query['leaf'] as string | undefined;
      const filterParam = req.query['filter'] as string | undefined;

      let leafUuid: string;
      if (leafParam) {
        leafUuid = leafParam;
      } else {
        const active = conv.activeLeaf;
        if (!active) {
          res.status(404).json({ detail: 'No active leaf found' });
          return;
        }
        leafUuid = active.uuid;
      }

      let path = conv.walkPath(leafUuid);
      if (path.length === 0) {
        res.status(404).json({ detail: `UUID not found in tree: ${leafUuid}` });
        return;
      }

      if (filterParam === 'messages') {
        path = path.filter((e) => e.type === 'user' || e.type === 'assistant');
      }

      res.json(
        path.map((e) => ({
          uuid: e.uuid,
          type: e.type,
          role: isUserEntry(e) || isAssistantEntry(e) ? e.message.role : null,
          preview: preview(e),
        })),
      );
    } catch (e) {
      handleError(res, e);
    }
  });

  // --- GET /api/sessions/:id/messages ---

  app.get('/api/sessions/:id/messages', (req: Request, res: Response) => {
    try {
      const conv = loadConversation(req.params['id'] as string);
      const active = conv.activeLeaf;
      if (!active) {
        res.status(404).json({ detail: 'No active leaf found' });
        return;
      }

      const path = conv.walkPath(active.uuid);
      path.reverse(); // leaf→root to root→leaf

      const messages: { uuid: string; role: string; content: string | Record<string, unknown>[] }[] = [];

      for (const entry of path) {
        if (isUserEntry(entry)) {
          messages.push({
            uuid: entry.uuid,
            role: 'user',
            content: entry.message.content,
          });
        } else if (isAssistantEntry(entry)) {
          // model_dump(exclude_none=True) equivalent: spread and filter nulls
          const blocks = entry.message.content.map((block: ContentBlock) => {
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(block)) {
              if (v !== null && v !== undefined) {
                obj[k] = v;
              }
            }
            return obj;
          });
          messages.push({
            uuid: entry.uuid,
            role: 'assistant',
            content: blocks,
          });
        }
      }

      res.json(messages);
    } catch (e) {
      handleError(res, e);
    }
  });

  // --- POST /api/converse (SSE) ---

  app.post('/api/converse', async (req: Request, res: Response) => {
    const body = req.body as {
      instruction: string;
      session_id?: string;
      leaf_uuid?: string;
      model: string;
      system_prompt: string;
      permission_mode?: string;
    };

    console.info(
      `converse: ${body.instruction?.slice(0, 80)} | model=${body.model} prompt=${body.system_prompt?.length ?? 0} chars`,
    );

    // Fork if rewinding to a specific leaf
    let sessionId = body.session_id ?? undefined;
    let shouldFork = false;

    if (body.leaf_uuid && body.session_id) {
      const sessionPath = findSessionFile(body.session_id);
      if (sessionPath) {
        sessionId = forkSession(sessionPath, body.leaf_uuid);
        shouldFork = true;
        console.info(`forked session ${body.session_id} -> ${sessionId} at leaf ${body.leaf_uuid}`);
      }
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sse(data: Record<string, unknown>): void {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      let nChunks = 0;
      for await (const chunk of claude.converse(body.instruction, {
        model: body.model,
        systemPrompt: body.system_prompt,
        cwd: PROJECT_CWD,
        sessionId,
        permissionMode: (body.permission_mode ?? 'plan') as PermissionMode,
        fork: shouldFork,
      })) {
        switch (chunk.kind) {
          case 'text':
            if (chunk.text) {
              nChunks++;
              sse({ text: chunk.text });
            }
            break;
          case 'block':
            sse({ block: chunk.block });
            break;
          case 'result': {
            console.info(`done: ${nChunks} chunks, cost=$${chunk.costUsd}, ${chunk.durationMs}ms`);
            const event: Record<string, unknown> = {
              done: true,
              session_id: chunk.sessionId,
              cost_usd: chunk.costUsd,
              duration_ms: chunk.durationMs,
            };
            if (chunk.error) {
              event['error'] = chunk.error;
            }
            sse(event);
            break;
          }
        }
      }
    } catch (e) {
      console.error('converse error:', e);
      sse({ done: true, error: e instanceof Error ? e.message : String(e) });
    }

    res.end();
  });

  return app;
}

// --- Error helper ---

function handleError(res: Response, e: unknown): void {
  if (typeof e === 'object' && e !== null && 'status' in e) {
    const err = e as { status: number; message: string };
    res.status(err.status).json({ detail: err.message });
  } else {
    console.error(e);
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
  }
}
