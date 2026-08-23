/**
 * Streams a single deployment's log: every line is timestamped, appended to the deployment's log
 * file on disk, and emitted live (`'line'`) so a route can tail it over SSE/WebSocket while the
 * deploy is running. `close()` finalizes the file and emits `'end'`.
 *
 * Writes go through a synchronously-opened file descriptor (not `fs.createWriteStream`) so that by
 * the time `line()`/`close()` return, the data is guaranteed to be on disk — callers (and tests)
 * reading the log file right after `runDeploy` resolves never race a buffered async stream flush.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class DeployLogger extends EventEmitter {
  readonly filePath: string;

  private readonly fd: number;
  private closed = false;

  constructor(logFilePath: string) {
    super();
    this.filePath = logFilePath;
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    this.fd = fs.openSync(logFilePath, 'a');
  }

  /** Appends `[HH:MM:SS] <text>` (UTC) to the log file and emits `'line'` with that full string. */
  line(text: string): void {
    const timestamp = new Date().toISOString().slice(11, 19); // "HH:MM:SS", UTC
    const prefixed = `[${timestamp}] ${text}`;
    fs.writeSync(this.fd, prefixed + '\n');
    this.emit('line', prefixed);
  }

  /** A visually distinct section header line: `==> <title>`. */
  section(title: string): void {
    this.line(`==> ${title}`);
  }

  /** Closes the log file and emits `'end'`. Idempotent — safe to call more than once. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    fs.closeSync(this.fd);
    this.emit('end');
  }
}
