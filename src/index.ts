/**
 * Package entry point: the Forth-subset compiler, the two DC4CD-port
 * programs (aggregation relay, fuzzy fire detection) and the consortium
 * generators (slot mode and tree mode). The tree-mode `readingTag` is
 * exported as `treeReadingTag`, because the slot-mode module already
 * exports a `readingTag`. The machine itself,
 * its reference VM and the keeper helpers come from the `k17-vm` package.
 */
export * from './forth/compiler'
export * from './programs/relay'
export * from './programs/fuzzy'
export * from './programs/consortium'
export {
    ADMIT_TAG,
    READING_TAG_BASE,
    REMOVE_TAG,
    TreeConsortiumOptions,
    readingTag as treeReadingTag,
    roundAt,
    treeConsortiumProgram,
    treeConsortiumSource,
} from './programs/treeConsortium'
