/**
 * Mocha root hook: no test may reach the network.
 *
 * Loaded through `.mocharc` `require` before any test file. It replaces the
 * global `fetch` and `net.Socket.prototype.connect` so that a call to any
 * host that is not local (localhost, 127.0.0.1, ::1, a Unix socket) is
 * refused with "network blocked: <host>" and recorded. The `afterEach`
 * root hook fails the test that made such a call; `afterAll` fails the run
 * when a call happened outside a test (for example when a module was
 * loaded).
 */
import * as net from 'net'

/** Network calls that were refused and not yet reported. */
const attempts: string[] = []

/** True for a host that the tests may use. */
function isLocal(host: string | undefined): boolean {
    return (
        !host || host === 'localhost' || host === '127.0.0.1' || host === '::1'
    )
}

/**
 * Record and refuse a network call.
 * Input: a text that names the call. Output: never; throws.
 */
function refuse(what: string): never {
    attempts.push(what)
    throw new Error(`network blocked: ${what}`)
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
): net.Socket {
    const first = args[0]
    const options =
        typeof first === 'object' && first !== null
            ? (first as { host?: string; path?: string; port?: number })
            : { port: first as number, host: args[1] as string | undefined }
    if (!options.path && !isLocal(options.host))
        refuse(`socket ${options.host}:${options.port}`)
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof net.Socket.prototype.connect

globalThis.fetch = (async (input: unknown) =>
    refuse(`fetch ${String(input)}`)) as typeof fetch

/** Fail with the recorded calls, if any, and clear them. */
function failOnAttempts(where: string): void {
    if (!attempts.length) return
    const calls = attempts.splice(0).join(', ')
    throw new Error(`${where} tried to use the network: ${calls}`)
}

/** The root hooks that mocha registers. */
export const mochaHooks = {
    afterEach(this: Mocha.Context): void {
        failOnAttempts(`test "${this.currentTest?.fullTitle()}"`)
    },
    afterAll(): void {
        failOnAttempts('the test run')
    },
}
