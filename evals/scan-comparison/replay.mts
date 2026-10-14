import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  writeFixture,
  type createFixture,
} from "../secret-discovery/fixtures.mts"

export async function stageFixture(
  repo: string,
  fixture: ReturnType<typeof createFixture>,
) {
  for (const name of Object.keys(fixture.files)) {
    const path = relative(repo, resolve(repo, name))
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`Fixture path escapes the repository: ${name}`)
    }
  }
  await writeFixture(repo, fixture)
}
