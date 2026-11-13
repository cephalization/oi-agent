import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Store } from "../src/store.ts"

/** A store in a fresh temporary directory. */
export const tempStore = (): Store => new Store(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-test-")))

/** Every file under a directory, as sorted paths relative to it. */
export const tree = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
