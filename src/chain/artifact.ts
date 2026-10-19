/**
 * Loading of the K17Machine contract artifact.
 *
 * A `K17Machine` can be made, decoded or rebuilt from a transaction only
 * after its compiled artifact (`k17-vm/artifacts/k17Machine.json`) is
 * loaded. The k17forth chain commands (`inspect`, `deploy`, `endorse`,
 * `keeper`, `gateway`) call `loadK17Artifact` before they start.
 */

import { K17Machine } from 'k17-vm'

let loaded = false

/**
 * Load the K17Machine artifact, one time per process.
 * Input: none. Output: none. Later calls do nothing. Throws when the
 * artifact file is missing (build k17-vm first).
 */
export function loadK17Artifact(): void {
    if (loaded) return
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    K17Machine.loadArtifact(require('k17-vm/artifacts/k17Machine.json'))
    loaded = true
}
