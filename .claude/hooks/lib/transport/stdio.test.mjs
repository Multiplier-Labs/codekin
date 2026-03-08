import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StdioTransport } from './stdio.mjs';

describe('StdioTransport', () => {
  let transport;
  const originalStdin = process.stdin;

  beforeEach(() => {
    transport = new StdioTransport();
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  describe('readInput()', () => {
    it('parses valid JSON from stdin', async () => {
      const data = { key: 'value', num: 42 };
      const mockStdin = {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify(data));
        },
      };
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      const result = await transport.readInput();
      expect(result).toEqual(data);
    });

    it('concatenates multiple chunks', async () => {
      const mockStdin = {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('{"he');
          yield Buffer.from('llo": "wo');
          yield Buffer.from('rld"}');
        },
      };
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      const result = await transport.readInput();
      expect(result).toEqual({ hello: 'world' });
    });

    it('throws descriptive error on invalid JSON', async () => {
      const mockStdin = {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('not valid json');
        },
      };
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

      await expect(transport.readInput()).rejects.toThrow('Hook received invalid JSON on stdin');
    });
  });

  describe('writeOutput()', () => {
    it('writes JSON-stringified output to stdout', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const data = { result: 'ok', count: 3 };

      transport.writeOutput(data);

      expect(writeSpy).toHaveBeenCalledOnce();
      expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(data));
      writeSpy.mockRestore();
    });
  });

  describe('writeError()', () => {
    it('writes message to stderr', () => {
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const message = 'something went wrong';

      transport.writeError(message);

      expect(writeSpy).toHaveBeenCalledOnce();
      expect(writeSpy).toHaveBeenCalledWith(message);
      writeSpy.mockRestore();
    });
  });
});
