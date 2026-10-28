import { OPEN_KNOWLEDGE_MCP_WRITE_TOOLS } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getCurrentMcpLogger, McpLogger } from './logger.ts';
import { createLoggedServer, wrapToolHandlerForLogging } from './tool-logging.ts';
import { textPlusStructured } from './tools/shared.ts';

describe('tool logging wrapper', () => {
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('wrapToolHandlerForLogging logs start and finish with summarized args/results', async () => {
    const logger = new McpLogger('mcp');
    const handler = wrapToolHandlerForLogging(
      'write_document',
      async () => {
        expect(getCurrentMcpLogger()).toBeDefined();
        return textPlusStructured('Written successfully.', {
          previewUrl: 'http://localhost:4242/#/notes/test',
          previewUrlSource: 'lock',
          warning: {
            message: 'No preview attached.',
            previewUrl: 'http://localhost:4242/#/notes/test',
          },
        });
      },
      {
        logger,
        identityRef: {
          current: {
            connectionId: '12345678-90ab-cdef-1234-567890abcdef',
            displayName: 'Codex',
            colorSeed: 'Codex',
            clientInfo: { name: 'codex', version: '1.0.0' },
          },
        },
      },
    );

    await handler(
      {
        docName: 'notes/test',
        markdown: '# Heading\nBody',
        position: 'replace',
      },
      {
        requestId: 'req-123',
        sessionId: 'transport-456',
        signal: new AbortController().signal,
      },
    );

    expect(stderrLines).toHaveLength(2);

    const start = JSON.parse(stderrLines[0] ?? '');
    const finish = JSON.parse(stderrLines[1] ?? '');

    expect(start.msg).toBe('tool start');
    expect(start.tool).toBe('write_document');
    expect(start.requestId).toBe('req-123');
    expect(start.transportSessionId).toBe('transport-456');
    expect(start.args.docName).toBe('notes/test');
    expect(start.args.markdown).toEqual({
      redacted: true,
      type: 'string',
      length: 14,
      lines: 2,
    });
    expect(start.agent).toEqual({
      connectionId: '12345678',
      displayName: 'Codex',
      clientName: 'codex',
    });

    expect(finish.msg).toBe('tool finish');
    expect(finish.tool).toBe('write_document');
    expect(finish.requestId).toBe('req-123');
    expect(finish.result).toMatchObject({
      isError: false,
      previewUrl: 'http://localhost:4242/#/notes/test',
      previewUrlSource: 'lock',
      warning: true,
      warningPreviewUrl: 'http://localhost:4242/#/notes/test',
    });
    expect(typeof finish.durationMs).toBe('number');
  });

  test('createLoggedServer wraps handlers during tool registration', async () => {
    const logger = new McpLogger('mcp');
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: (...args: unknown[]) => {
        capturedHandler = args.at(-1) as (...args: unknown[]) => unknown;
        return 'registered';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, { logger });
    const originalHandler = async () => textPlusStructured('ok', { previewUrl: null });

    expect(
      (wrapped as unknown as { tool: (...args: unknown[]) => unknown }).tool(
        'preview_url',
        'desc',
        { docName: 'string' },
        originalHandler,
      ),
    ).toBe('registered');
    expect(capturedHandler).toBeDefined();
    expect(capturedHandler).not.toBe(originalHandler);

    const wrappedHandler = capturedHandler;
    if (!wrappedHandler) {
      throw new Error('Expected wrapped handler to be captured');
    }

    await wrappedHandler(
      { docName: 'notes/test' },
      { requestId: 'req-456', signal: new AbortController().signal },
    );

    const finish = JSON.parse(stderrLines[1] ?? '');
    expect(finish.tool).toBe('preview_url');
    expect(finish.result.previewUrl).toBeNull();
  });

  test('createLoggedServer wraps handlers during registerTool registration', async () => {
    const logger = new McpLogger('mcp');
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: () => 'legacy-registered',
      registerTool: (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
        expect(name).toBe('read_document');
        expect(config).toEqual({
          description: 'desc',
          inputSchema: { docName: 'string' },
        });
        capturedHandler = handler;
        return 'registered-tool';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, { logger });
    const originalHandler = async () =>
      textPlusStructured('ok', { previewUrl: null, documents: ['a', 'b'] });

    expect(
      (
        wrapped as unknown as {
          registerTool: (
            name: string,
            config: unknown,
            handler: (...args: unknown[]) => unknown,
          ) => unknown;
        }
      ).registerTool(
        'read_document',
        { description: 'desc', inputSchema: { docName: 'string' } },
        originalHandler,
      ),
    ).toBe('registered-tool');
    expect(capturedHandler).toBeDefined();
    expect(capturedHandler).not.toBe(originalHandler);

    const wrappedHandler = capturedHandler;
    if (!wrappedHandler) {
      throw new Error('Expected wrapped registerTool handler to be captured');
    }

    await wrappedHandler(
      { docName: 'notes/test' },
      { requestId: 'req-789', signal: new AbortController().signal },
    );

    const finish = JSON.parse(stderrLines[1] ?? '');
    expect(finish.tool).toBe('read_document');
    expect(finish.requestId).toBe('req-789');
    expect(finish.result.previewUrl).toBeNull();
    expect(finish.result.documentsCount).toBe(2);
  });

  describe('read-only write guard', () => {
    function captureViaRegisterTool(
      name: string,
      principal: { role: 'reader' | 'writer' } | undefined,
      originalHandler: (...args: unknown[]) => unknown,
    ): (...args: unknown[]) => unknown {
      const logger = new McpLogger('mcp');
      let captured: ((...args: unknown[]) => unknown) | undefined;
      const fakeServer = {
        tool: () => 'legacy',
        registerTool: (_n: string, _c: unknown, handler: (...args: unknown[]) => unknown) => {
          captured = handler;
          return 'registered';
        },
      };
      const wrapped = createLoggedServer(fakeServer as never, {
        logger,
        ...(principal ? { principal } : {}),
      });
      (
        wrapped as unknown as {
          registerTool: (n: string, c: unknown, h: (...args: unknown[]) => unknown) => unknown;
        }
      ).registerTool(name, { description: 'd', inputSchema: {} }, originalHandler);
      if (!captured) throw new Error('handler not captured');
      return captured;
    }

    const callArgs = (args: Record<string, unknown>) => [
      args,
      { requestId: 'req-ro', signal: new AbortController().signal },
    ];

    test('reader: a mutating tool (write) is refused and the real handler never runs', async () => {
      let handlerRan = false;
      const handler = captureViaRegisterTool('write', { role: 'reader' }, async () => {
        handlerRan = true;
        return textPlusStructured('wrote', {});
      });

      const result = (await handler(...callArgs({ path: 'notes/x', content: 'hi' }))) as {
        isError?: boolean;
        content: { text: string }[];
      };

      expect(handlerRan).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('read-only mode');
      expect(result.content[0]?.text).toContain('`write`');
    });

    test('reader: lint({fix:true}) is refused but plain lint passes through', async () => {
      let ranCount = 0;
      const handler = captureViaRegisterTool('lint', { role: 'reader' }, async () => {
        ranCount += 1;
        return textPlusStructured('linted', {});
      });

      const fixResult = (await handler(...callArgs({ document: 'x', fix: true }))) as {
        isError?: boolean;
      };
      expect(fixResult.isError).toBe(true);
      expect(ranCount).toBe(0);

      const plainResult = (await handler(...callArgs({ document: 'x' }))) as { isError?: boolean };
      expect(plainResult.isError ?? false).toBe(false);
      expect(ranCount).toBe(1);
    });

    test('reader: a read tool (search) passes through untouched', async () => {
      let ran = false;
      const handler = captureViaRegisterTool('search', { role: 'reader' }, async () => {
        ran = true;
        return textPlusStructured('results', { results: [] });
      });

      const result = (await handler(...callArgs({ query: 'x' }))) as { isError?: boolean };
      expect(ran).toBe(true);
      expect(result.isError ?? false).toBe(false);
    });

    test('writer: a mutating tool runs normally (OFF-path parity)', async () => {
      let ran = false;
      const handler = captureViaRegisterTool('write', { role: 'writer' }, async () => {
        ran = true;
        return textPlusStructured('wrote', {});
      });

      const result = (await handler(...callArgs({ path: 'x', content: 'y' }))) as {
        isError?: boolean;
      };
      expect(ran).toBe(true);
      expect(result.isError ?? false).toBe(false);
    });

    test('no principal (stock): the guard adds nothing — a mutating handler runs and passes through', async () => {
      let ran = false;
      const original = async () => textPlusStructured('wrote', {});
      // No principal: wrapToolHandlerForWriteGuard returns the handler
      // untouched. (Telemetry still wraps unconditionally, so this asserts
      // behavioral parity, not reference identity.)
      const handler = captureViaRegisterTool('write', undefined, async (...a: unknown[]) => {
        ran = true;
        return original(...(a as []));
      });

      const result = (await handler(...callArgs({ path: 'x', content: 'y' }))) as {
        isError?: boolean;
      };
      expect(ran).toBe(true);
      expect(result.isError ?? false).toBe(false);
    });

    // --- Parametrized coverage (QA/Idan): the existing cases above prove the
    // guard with ONE write tool (write) and ONE read tool (search). The guard
    // is name-agnostic (membership in OPEN_KNOWLEDGE_MCP_WRITE_TOOLS, plus the
    // lint({fix:true}) special case), so the loops below assert that property
    // holds for EVERY write tool and a representative set of read tools, rather
    // than trusting it by inspection. ---

    // (a) Under a reader principal, every canonical write tool is refused and
    // its real handler never runs.
    test.each([...OPEN_KNOWLEDGE_MCP_WRITE_TOOLS])(
      'reader: mutating tool %s is refused with isError and never runs',
      async (toolName) => {
        let handlerRan = false;
        const handler = captureViaRegisterTool(toolName, { role: 'reader' }, async () => {
          handlerRan = true;
          return textPlusStructured('mutated', {});
        });

        const result = (await handler(...callArgs({ path: 'notes/x', content: 'hi' }))) as {
          isError?: boolean;
          content: { text: string }[];
        };

        expect(handlerRan).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('read-only mode');
        expect(result.content[0]?.text).toContain(`\`${toolName}\``);
      },
    );

    // Guard against drift: the loop above must be exhaustive over the canonical
    // write set (8 tools today). If core adds/removes a write tool, this fails
    // until the coverage is re-confirmed.
    test('the canonical write set is exactly the expected 8 tools', () => {
      expect([...OPEN_KNOWLEDGE_MCP_WRITE_TOOLS].sort()).toEqual(
        [
          'checkpoint',
          'delete',
          'edit',
          'import',
          'install',
          'move',
          'restore_version',
          'write',
        ].sort(),
      );
    });

    // (b) lint is the one argument-conditional case: fix:true mutates, plain
    // lint reads. Already covered by the single case above; re-stated here as a
    // named assertion so the a/b/c coverage map is explicit.
    test('reader: lint({fix:true}) refused, lint({}) passes through (arg-conditional)', async () => {
      let ranCount = 0;
      const handler = captureViaRegisterTool('lint', { role: 'reader' }, async () => {
        ranCount += 1;
        return textPlusStructured('linted', {});
      });

      const fixResult = (await handler(...callArgs({ document: 'd', fix: true }))) as {
        isError?: boolean;
      };
      expect(fixResult.isError).toBe(true);
      expect(ranCount).toBe(0);

      const plainResult = (await handler(...callArgs({}))) as { isError?: boolean };
      expect(plainResult.isError ?? false).toBe(false);
      expect(ranCount).toBe(1);
    });

    // (c) Under a reader principal, a representative set of read/search tools
    // pass through untouched (not refused, real handler runs).
    const READ_TOOLS = [
      'search',
      'exec',
      'links',
      'audit',
      'history',
      'skills',
      'palette',
      'config',
      'preview_url',
      'share_link',
    ] as const;

    test.each([...READ_TOOLS])(
      'reader: read tool %s passes through untouched',
      async (toolName) => {
        let ran = false;
        const handler = captureViaRegisterTool(toolName, { role: 'reader' }, async () => {
          ran = true;
          return textPlusStructured('ok', {});
        });

        const result = (await handler(...callArgs({ query: 'x', path: '.' }))) as {
          isError?: boolean;
        };
        expect(ran).toBe(true);
        expect(result.isError ?? false).toBe(false);
      },
    );

    // (off) Under a writer principal (read-only OFF), every write tool runs
    // normally — the gate adds nothing on the read-write posture.
    test.each([...OPEN_KNOWLEDGE_MCP_WRITE_TOOLS])(
      'writer: mutating tool %s runs normally (OFF-path parity)',
      async (toolName) => {
        let ran = false;
        const handler = captureViaRegisterTool(toolName, { role: 'writer' }, async () => {
          ran = true;
          return textPlusStructured('ok', {});
        });

        const result = (await handler(...callArgs({ path: 'x', content: 'y' }))) as {
          isError?: boolean;
        };
        expect(ran).toBe(true);
        expect(result.isError ?? false).toBe(false);
      },
    );
  });
});
