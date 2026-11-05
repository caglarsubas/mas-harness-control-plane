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

  it("resolves the id and calls notFound() before the first return on each dynamic page", () => {
    for (const [page, resolver] of Object.entries(DYNAMIC_PAGES)) {
      expect(renderOrderErrors(readFileSync(join(APP_ROOT, page), "utf8"), resolver), page).toEqual([]);
    }
  });

  it("refuses the false-pass shapes of a text-order check", () => {
    const resolver = "resolveHarnessProjection(";
    const commented = "export default async function Page() {\n  // resolveHarnessProjection(id); notFound();\n  return <Early />;\n}\n";
    const ternary = "export default async function Page() {\n  return ok ? <Early /> : null;\n  const projection = resolveHarnessProjection(id);\n  if (!projection) notFound();\n}\n";
    const element = "export default async function Page() {\n  return element;\n  const projection = resolveHarnessProjection(id);\n  if (!projection) notFound();\n  return <Late />;\n}\n";
    const correct = "/* return <Comment /> */\nfunction Helper() { return <Helper />; }\nexport default async function Page() {\n  const projection = resolveHarnessProjection(id);\n  if (!projection) notFound();\n  return <Suspense><Detail /></Suspense>;\n}\n";
    expect(renderOrderErrors(commented, resolver)).not.toEqual([]);
    expect(renderOrderErrors(ternary, resolver)).not.toEqual([]);
    expect(renderOrderErrors(element, resolver)).not.toEqual([]);
    expect(renderOrderErrors(correct, resolver)).toEqual([]);
  });
});

// Order inside the default export, comments removed: resolver call, then notFound(), then the first return, which must carry JSX.
function renderOrderErrors(source: string, resolver: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
  const start = code.indexOf("export default");
  if (start < 0) return ["no default export"];
  const body = code.slice(start);
  const resolved = body.indexOf(resolver);
  const missing = body.search(NOT_FOUND_CALL);
  const returned = body.search(/\breturn\b/u);
  const errors: string[] = [];
  if (resolved < 0) errors.push("no resolver call");
  if (missing < 0 || missing < resolved) errors.push("notFound() does not follow the resolver call");
  if (returned < 0 || returned < missing) errors.push("a return precedes notFound()");
  else if (!/^return\b[^;]*</u.test(body.slice(returned))) errors.push("the first return carries no JSX");
  return errors;
}
