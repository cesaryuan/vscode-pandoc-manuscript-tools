import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isStyleName } from "./zotero";

/** Saves a usable CSL in the workspace, reusing identical files and never replacing an existing local customization. */
export async function saveCslStyle(root: string, name: string, xml: string): Promise<string> {
  if (!isStyleName(name)) throw new Error("无效的 CSL 文件名");
  const directory = path.join(root, "pandoc", "csl");
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 1000; index++) {
    const filename = path.join(directory, `${name}${index ? `-${index}` : ""}.csl`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(filename, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await fs.readFile(filename, "utf8") === xml) return filename;
      continue;
    }
    try {
      await handle.writeFile(xml, "utf8");
    } catch (error) {
      // A failed disk write must not leave a partial CSL that later builds mistake for a valid style.
      await handle.close();
      await fs.rm(filename, { force: true });
      throw error;
    }
    await handle.close();
    return filename;
  }
  throw new Error("同名 CSL 文件过多，无法保存下载的样式");
}
