import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getChannelPort, getMcpServerKey, isChannelAlive,
  registerChannel, slugifyDataDir, triggerChannel, unregisterChannel,
} from './channel-config.js';

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `hs-channel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('registerChannel', () => {
  it('creates .mcp.json with per-project hotsheet-channel entry (HS-8349)', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const mcpPath = join(tempDir, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(config.mcpServers).toBeDefined();
    const serverKey = getMcpServerKey(dataDir);
    expect(serverKey.startsWith('hotsheet-channel-')).toBe(true);
    expect(config.mcpServers[serverKey]).toBeDefined();
    expect(config.mcpServers[serverKey].args).toContain('--data-dir');
    expect(config.mcpServers[serverKey].args).toContain(dataDir);
    // The legacy single-key entry must NOT be written.
    expect(config.mcpServers['hotsheet-channel']).toBeUndefined();
  });

  it('preserves existing mcpServers entries', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'other-server': { command: 'node', args: ['other.js'] },
      },
    }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['other-server'].command).toBe('node');
    expect(config.mcpServers[getMcpServerKey(dataDir)]).toBeDefined();
  });

  it('preserves other top-level keys in .mcp.json', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      someOtherKey: 'value',
      mcpServers: {},
    }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { someOtherKey: string; mcpServers: Record<string, unknown> };
    expect(config.someOtherKey).toBe('value');
    expect(config.mcpServers[getMcpServerKey(dataDir)]).toBeDefined();
  });

  it('overwrites existing per-project entry', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    const serverKey = getMcpServerKey(dataDir);
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        [serverKey]: { command: 'old-command', args: ['old'] },
      },
    }));
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(config.mcpServers[serverKey].args).toContain(dataDir);
    expect(config.mcpServers[serverKey].args).not.toContain('old');
  });

  it('migrates legacy hotsheet-channel entry to per-project key (HS-8349)', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'hotsheet-channel': { command: 'legacy', args: ['old-dir'] },
        'other-server': { command: 'node', args: ['other.js'] },
      },
    }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    // Legacy entry dropped.
    expect(config.mcpServers['hotsheet-channel']).toBeUndefined();
    // New per-project entry present with the new dataDir.
    const serverKey = getMcpServerKey(dataDir);
    expect(config.mcpServers[serverKey]).toBeDefined();
    expect(config.mcpServers[serverKey].args).toContain(dataDir);
    // Unrelated entries untouched.
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['other-server'].command).toBe('node');
  });

  it('handles corrupt .mcp.json by overwriting', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, 'not valid json{{{');
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers[getMcpServerKey(dataDir)]).toBeDefined();
  });

  it('creates mcpServers key if absent', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ someKey: 'val' }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers[getMcpServerKey(dataDir)]).toBeDefined();
  });

  it('keeps distinct per-project keys across two project directories (HS-8349)', () => {
    const dataDirA = join(tempDir, 'project-a', '.hotsheet');
    const dataDirB = join(tempDir, 'project-b', '.hotsheet');
    mkdirSync(dataDirA, { recursive: true });
    mkdirSync(dataDirB, { recursive: true });
    registerChannel(dataDirA);
    registerChannel(dataDirB);
    const mcpA = JSON.parse(readFileSync(join(tempDir, 'project-a', '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, { args: string[] }> };
    const mcpB = JSON.parse(readFileSync(join(tempDir, 'project-b', '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, { args: string[] }> };
    const keyA = getMcpServerKey(dataDirA);
    const keyB = getMcpServerKey(dataDirB);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('hotsheet-channel-project-a');
    expect(keyB).toBe('hotsheet-channel-project-b');
    expect(mcpA.mcpServers[keyA]).toBeDefined();
    expect(mcpA.mcpServers[keyA].args).toContain(dataDirA);
    expect(mcpB.mcpServers[keyB]).toBeDefined();
    expect(mcpB.mcpServers[keyB].args).toContain(dataDirB);
  });
});

describe('unregisterChannel', () => {
  it('removes per-project hotsheet-channel-<slug> entry from .mcp.json (HS-8349)', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    const mcpPath = join(tempDir, '.mcp.json');
    const serverKey = getMcpServerKey(dataDir);
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        [serverKey]: { command: 'node', args: ['channel.js'] },
        'other-server': { command: 'node', args: ['other.js'] },
      },
    }));
    unregisterChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers[serverKey]).toBeUndefined();
    expect(config.mcpServers['other-server']).toBeDefined();
  });

  it('also removes legacy hotsheet-channel entry (HS-8349 rollback safety)', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'hotsheet-channel': { command: 'legacy', args: ['old'] },
        'other-server': { command: 'node', args: ['other.js'] },
      },
    }));
    unregisterChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers['hotsheet-channel']).toBeUndefined();
    expect(config.mcpServers['other-server']).toBeDefined();
  });

  it('does nothing if .mcp.json does not exist', () => {
    // Should not throw
    expect(() => unregisterChannel()).not.toThrow();
  });

  it('does nothing if hotsheet-channel key is not present', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    const original = JSON.stringify({
      mcpServers: {
        'other-server': { command: 'node', args: ['other.js'] },
      },
    });
    writeFileSync(mcpPath, original);
    unregisterChannel();
    // File should still have other-server, content may be reformatted but key should be there
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers['other-server']).toBeDefined();
  });

  it('handles corrupt .mcp.json gracefully', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, 'not json!');
    expect(() => unregisterChannel()).not.toThrow();
  });
});

describe('getChannelPort', () => {
  it('reads port from channel-port file', () => {
    const dataDir = join(tempDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), '5555\n');
    expect(getChannelPort(dataDir)).toBe(5555);
  });

  it('returns null if channel-port file does not exist', () => {
    const dataDir = join(tempDir, 'no-port');
    mkdirSync(dataDir, { recursive: true });
    expect(getChannelPort(dataDir)).toBeNull();
  });

  it('returns null for non-numeric content', () => {
    const dataDir = join(tempDir, 'bad-port');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), 'not-a-number');
    expect(getChannelPort(dataDir)).toBeNull();
  });

  it('handles port with whitespace', () => {
    const dataDir = join(tempDir, 'ws-port');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), '  4200  \n');
    expect(getChannelPort(dataDir)).toBe(4200);
  });

  it('reads port zero correctly', () => {
    const dataDir = join(tempDir, 'zero-port');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), '0');
    expect(getChannelPort(dataDir)).toBe(0);
  });

  it('returns null for empty file', () => {
    const dataDir = join(tempDir, 'empty-port');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), '');
    expect(getChannelPort(dataDir)).toBeNull();
  });
});

describe('isChannelAlive', () => {
  it('returns false when no port file exists', async () => {
    const dataDir = join(tempDir, 'no-channel');
    mkdirSync(dataDir, { recursive: true });
    const alive = await isChannelAlive(dataDir);
    expect(alive).toBe(false);
  });

  it('returns false when port file has invalid content', async () => {
    const dataDir = join(tempDir, 'bad-channel');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), 'garbage');
    const alive = await isChannelAlive(dataDir);
    expect(alive).toBe(false);
  });

  it('returns false when channel server is not running', async () => {
    const dataDir = join(tempDir, 'dead-channel');
    mkdirSync(dataDir, { recursive: true });
    // Write a port that nothing is listening on
    writeFileSync(join(dataDir, 'channel-port'), '19999');
    const alive = await isChannelAlive(dataDir);
    expect(alive).toBe(false);
  });

  it('returns true when channel server responds with ok', async () => {
    const dataDir = join(tempDir, 'live-channel');
    mkdirSync(dataDir, { recursive: true });

    // Start a minimal HTTP server that mimics the health endpoint
    const { createServer } = await import('http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    const alive = await isChannelAlive(dataDir);
    expect(alive).toBe(true);

    server.close();
  });

  it('returns false when health endpoint returns non-ok', async () => {
    const dataDir = join(tempDir, 'bad-health-channel');
    mkdirSync(dataDir, { recursive: true });

    const { createServer } = await import('http');
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    const alive = await isChannelAlive(dataDir);
    expect(alive).toBe(false);

    server.close();
  });
});

describe('triggerChannel', () => {
  it('returns false when no port file exists', async () => {
    const dataDir = join(tempDir, 'no-trigger');
    mkdirSync(dataDir, { recursive: true });
    const result = await triggerChannel(dataDir, 4174);
    expect(result).toBe(false);
  });

  it('returns false when channel server is not running', async () => {
    const dataDir = join(tempDir, 'dead-trigger');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'channel-port'), '19998');
    const result = await triggerChannel(dataDir, 4174);
    expect(result).toBe(false);
  });

  it('sends default message when no custom message provided', async () => {
    const dataDir = join(tempDir, 'trigger-default');
    mkdirSync(dataDir, { recursive: true });

    let receivedBody = '';
    const { createServer } = await import('http');
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/trigger') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        receivedBody = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    const result = await triggerChannel(dataDir, 4174);
    expect(result).toBe(true);
    expect(receivedBody).toContain('Process the Hot Sheet worklist');
    expect(receivedBody).toContain('/hotsheet');
    // Should include the done signal
    expect(receivedBody).toContain('curl');
    expect(receivedBody).toContain('api/channel/done');

    server.close();
  });

  it('sends custom message when provided', async () => {
    const dataDir = join(tempDir, 'trigger-custom');
    mkdirSync(dataDir, { recursive: true });

    let receivedBody = '';
    const { createServer } = await import('http');
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/trigger') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        receivedBody = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    const result = await triggerChannel(dataDir, 4174, 'Custom trigger message');
    expect(result).toBe(true);
    expect(receivedBody).toContain('Custom trigger message');
    // Should NOT contain the default message
    expect(receivedBody).not.toContain('Process the Hot Sheet worklist');
    // But should still have the done signal
    expect(receivedBody).toContain('api/channel/done');

    server.close();
  });

  it('includes server port in the done signal URL', async () => {
    const dataDir = join(tempDir, 'trigger-port');
    mkdirSync(dataDir, { recursive: true });

    let receivedBody = '';
    const { createServer } = await import('http');
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/trigger') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        receivedBody = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    await triggerChannel(dataDir, 7777);
    expect(receivedBody).toContain('http://localhost:7777/api/channel/done');

    server.close();
  });

  it('returns false when trigger endpoint returns error', async () => {
    const dataDir = join(tempDir, 'trigger-error');
    mkdirSync(dataDir, { recursive: true });

    const { createServer } = await import('http');
    const server = createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dataDir, 'channel-port'), String(port));

    const result = await triggerChannel(dataDir, 4174);
    expect(result).toBe(false);

    server.close();
  });
});

describe('registerChannel file format', () => {
  it('writes .mcp.json with trailing newline and pretty formatting', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const mcpPath = join(tempDir, '.mcp.json');
    const raw = readFileSync(mcpPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    // Should be pretty-printed (contains newlines within the JSON)
    expect(raw.split('\n').length).toBeGreaterThan(2);
  });

  it('sets command to node or npx depending on environment', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const mcpPath = join(tempDir, '.mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = config.mcpServers[getMcpServerKey(dataDir)];
    // Command should be either 'node' or 'npx'
    expect(['node', 'npx']).toContain(entry.command);
  });
});

describe('slugifyDataDir (HS-8349)', () => {
  it('uses the basename of the project root (parent of .hotsheet/)', () => {
    expect(slugifyDataDir('/Users/x/Documents/hotsheet/.hotsheet')).toBe('hotsheet');
    expect(slugifyDataDir('/Users/x/Documents/kerf/.hotsheet')).toBe('kerf');
  });

  it('lowercases mixed-case basenames', () => {
    expect(slugifyDataDir('/projects/MyProject/.hotsheet')).toBe('myproject');
  });

  it('collapses non-alphanumeric runs to a single dash', () => {
    expect(slugifyDataDir('/projects/my project/.hotsheet')).toBe('my-project');
    expect(slugifyDataDir('/projects/foo.bar_baz/.hotsheet')).toBe('foo-bar-baz');
    expect(slugifyDataDir('/projects/a@@b##c/.hotsheet')).toBe('a-b-c');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyDataDir('/projects/--foo--/.hotsheet')).toBe('foo');
    expect(slugifyDataDir('/projects/.foo./.hotsheet')).toBe('foo');
  });

  it('falls back to "project" when the basename has no alphanumerics', () => {
    expect(slugifyDataDir('/projects/!!!/.hotsheet')).toBe('project');
  });

  it('handles dataDir without trailing .hotsheet', () => {
    // Some callers may pass the project root directly.
    expect(slugifyDataDir('/Users/x/Documents/hotsheet')).toBe('hotsheet');
  });

  it('handles trailing slash on .hotsheet/', () => {
    expect(slugifyDataDir('/Users/x/Documents/hotsheet/.hotsheet/')).toBe('hotsheet');
  });

  it('is stable across repeated invocations', () => {
    const a = slugifyDataDir('/projects/MyApp/.hotsheet');
    const b = slugifyDataDir('/projects/MyApp/.hotsheet');
    expect(a).toBe(b);
  });
});

describe('getMcpServerKey (HS-8349)', () => {
  it('prepends "hotsheet-channel-" to the slug', () => {
    expect(getMcpServerKey('/Users/x/Documents/hotsheet/.hotsheet')).toBe('hotsheet-channel-hotsheet');
    expect(getMcpServerKey('/projects/MyApp/.hotsheet')).toBe('hotsheet-channel-myapp');
  });

  it('produces distinct keys for distinct project roots', () => {
    expect(getMcpServerKey('/projects/a/.hotsheet')).not.toBe(getMcpServerKey('/projects/b/.hotsheet'));
  });
});
