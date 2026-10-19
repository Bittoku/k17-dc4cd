/**
 * The sensor bridge: readings from a DC4CD bridge mote.
 *
 * The bridge mote (see `docs/bridge-mote.fs`) prints one line per reading,
 * `R <reading>`, where the reading is a decimal number that the mote word
 * already moved into the unsigned cell range. `openBridge` reads such lines
 * from a serial device, from standard input, or from any readable stream
 * (tests use an in-memory stream), and gives the readings in order. Lines
 * that are not `R <decimal>` (echo, prompts, noise) are ignored. A serial
 * device is opened only when the first reading is asked for, through the
 * `serialport` package, which is loaded only then.
 */

/** Baud rate of the bridge mote's serial line. */
export const BRIDGE_BAUD_RATE = 115_200

/** One reading line: `R`, white space, a decimal number. */
const READING_LINE = /^R\s+(\d+)\s*$/

/** The readings of an open bridge, and a way to close it. */
export interface Bridge extends AsyncIterable<number> {
    /** Close the stream under the bridge, if it was opened. */
    close(): void
}

/** Options of `openBridge`. */
export interface BridgeOptions {
    /** Serial baud rate for a device path. Default: BRIDGE_BAUD_RATE. */
    baudRate?: number
    /** Called with each line that is not a reading. Default: ignore it. */
    onIgnored?: (line: string) => void
}

/**
 * Read one line of the bridge protocol.
 * Input: a line without its end-of-line characters. Output: the reading, or
 * undefined when the line is not `R <decimal>`.
 */
export function parseReadingLine(line: string): number | undefined {
    const match = READING_LINE.exec(line.trim())
    return match ? Number(match[1]) : undefined
}

/**
 * Open a serial device as a stream, with the `serialport` package.
 * Input: device path and baud rate. Output: the open port (a readable
 * stream). The package is loaded here so that no other path needs it.
 */
function openSerial(path: string, baudRate: number): NodeJS.ReadableStream {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SerialPort } = require('serialport') as typeof import('serialport')
    return new SerialPort({ path, baudRate })
}

/**
 * Give the readings of a text stream, one per `R <reading>` line.
 * Input: the stream and the options. Output: the readings in order; ends
 * when the stream ends (a last line without an end-of-line also counts).
 */
async function* readingsOf(
    stream: NodeJS.ReadableStream,
    options: BridgeOptions
): AsyncGenerator<number> {
    let rest = ''
    const take = (line: string): number | undefined => {
        const value = parseReadingLine(line)
        if (value === undefined && line.trim() !== '') options.onIgnored?.(line)
        return value
    }
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const lines = rest.split('\n')
        rest = lines.pop() as string
        for (const line of lines) {
            const value = take(line)
            if (value !== undefined) yield value
        }
    }
    const value = take(rest)
    if (value !== undefined) yield value
}

/**
 * Open the bridge.
 * Input: a serial device path (for example /dev/ttyUSB0), the word 'stdin'
 * for standard input, or a readable stream; and the options.
 * Output: the readings, in the order the mote sent them, and `close` to
 * stop reading (it destroys a device or stream, and pauses standard
 * input). A device is opened when the readings are first asked for.
 */
export function openBridge(
    source: string | NodeJS.ReadableStream,
    options: BridgeOptions = {}
): Bridge {
    let opened: NodeJS.ReadableStream | undefined
    return {
        [Symbol.asyncIterator]: () => {
            opened =
                typeof source !== 'string'
                    ? source
                    : source === 'stdin'
                    ? process.stdin
                    : openSerial(source, options.baudRate ?? BRIDGE_BAUD_RATE)
            return readingsOf(opened, options)
        },
        close: () => {
            const stream = opened as
                | (NodeJS.ReadableStream & { destroy?: () => void })
                | undefined
            if (stream === process.stdin) stream.pause()
            else stream?.destroy?.()
        },
    }
}
