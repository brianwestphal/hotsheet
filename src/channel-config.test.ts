import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getChannelPort, registerChannel, unregisterChannel } from './channel-config.js';

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
  it('creates .mcp.json with hotsheet-channel entry', () => {
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const mcpPath = join(tempDir, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers['hotsheet-channel']).toBeDefined();
    expect(config.mcpServers['hotsheet-channel'].args).toContain('--data-dir');
    expect(config.mcpServers['hotsheet-channel'].args).toContain(dataDir);
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
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['other-server'].command).toBe('node');
    expect(config.mcpServers['hotsheet-channel']).toBeDefined();
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
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.someOtherKey).toBe('value');
    expect(config.mcpServers['hotsheet-channel']).toBeDefined();
  });

  it('overwrites existing hotsheet-channel entry', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'hotsheet-channel': { command: 'old-command', args: ['old'] },
      },
    }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers['hotsheet-channel'].args).toContain(dataDir);
    expect(config.mcpServers['hotsheet-channel'].args).not.toContain('old');
  });

  it('handles corrupt .mcp.json by overwriting', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, 'not valid json{{{');
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers['hotsheet-channel']).toBeDefined();
  });

  it('creates mcpServers key if absent', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ someKey: 'val' }));
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    registerChannel(dataDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers['hotsheet-channel']).toBeDefined();
  });
});

describe('unregisterChannel', () => {
  it('removes hotsheet-channel from .mcp.json', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'hotsheet-channel': { command: 'node', args: ['channel.js'] },
        'other-server': { command: 'node', args: ['other.js'] },
      },
    }));
    unregisterChannel();
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
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
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
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
});
