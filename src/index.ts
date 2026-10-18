/**
 * Package entry point: the Forth-subset compiler and the two DC4CD-port
 * programs (aggregation relay, fuzzy fire detection). The machine itself,
 * its reference VM and the keeper helpers come from the `k17-vm` package.
 */
export * from './forth/compiler'
export * from './programs/relay'
export * from './programs/fuzzy'
