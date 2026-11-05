import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve("apps/control-web/src/app");
const NOT_FOUND_CALL = /\bnotFound\(\)/u;
const DYNAMIC_PAGES = {
  "organizations/[organizationId]/page.tsx": "resolveOrganizationProjection(",
  "harnesses/[harnessId]/page.tsx": "resolveHarnessProjection(",
  "planes/[planeId]/page.tsx": "resolvePlaneProjection(",
} as const;

interface NotFoundScan {
  readonly notFoundPages: readonly string[];
  readonly pairs: readonly (readonly [page: string, loading: string])[];
}

const portable = (root: string, path: string): string => relative(root, path).split(sep).join("/");

// A loading.tsx at or above a notFound() page streams a 200 shell before the page can decide 404.
function scanNotFoundBoundaries(root: string): NotFoundScan {
  const pages: string[] = [];
  const loadings = new Set<string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && name === "page.tsx") pages.push(path);
      else if (stat.isFile() && name === "loading.tsx") loadings.add(path);
    }
  };
  visit(root);
  const notFoundPages = pages.filter((page) => NOT_FOUND_CALL.test(readFileSync(page, "utf8")));
  const pairs: (readonly [string, string])[] = [];
  for (const page of notFoundPages) {
    for (let directory = dirname(page); ; directory = dirname(directory)) {
      const loading = join(directory, "loading.tsx");
      if (loadings.has(loading)) pairs.push([portable(root, page), portable(root, loading)]);
      if (directory === root || dirname(directory) === directory) break;
    }
  }
  return { notFoundPages: notFoundPages.map((page) => portable(root, page)), pairs };
}

describe("page destinations decide not-found before any loading boundary streams", () => {
  it("keeps every notFound() page free of loading.tsx in its own or any ancestor segment", () => {
    const scan = scanNotFoundBoundaries(APP_ROOT);
    expect(scan.pairs).toEqual([]);
    expect(scan.notFoundPages).toEqual(expect.arrayContaining(Object.keys(DYNAMIC_PAGES)));
  });

  it("detects a synthetic loading boundary above a notFound() page", () => {
    const root = mkdtempSync(join(tmpdir(), "page-not-found-status-"));
    try {
      const write = (path: string, source: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source);
      };
      write("guarded/loading.tsx", "export default function Loading() { return null; }\n");
      write("guarded/[id]/page.tsx", "export default function Page() { notFound(); }\n");
      write("plain/loading.tsx", "export default function Loading() { return null; }\n");
      write("plain/page.tsx", "export default function Page() { return null; }\n");
      write("clean/[id]/page.tsx", "export default function Page() { notFound(); }\n");
      expect(scanNotFoundBoundaries(root).pairs).toEqual([["guarded/[id]/page.tsx", "guarded/loading.tsx"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the id and calls notFound() before the first JSX return on each dynamic page", () => {
    for (const [page, resolver] of Object.entries(DYNAMIC_PAGES)) {
      const source = readFileSync(join(APP_ROOT, page), "utf8");
      const resolved = source.indexOf(resolver);
      const missing = source.search(NOT_FOUND_CALL);
      const rendered = source.search(/return\s*\(?\s*</u);
      expect(resolved, page).toBeGreaterThan(-1);
      expect(missing, page).toBeGreaterThan(resolved);
      expect(rendered, page).toBeGreaterThan(missing);
    }
  });
});
