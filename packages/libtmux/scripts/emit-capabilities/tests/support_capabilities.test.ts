import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseTmuxVersion } from "../../../src/_internal/runtime/tmux_version.js";
import {
  CAPABILITIES,
  WORKAROUNDS,
  capabilityManifest,
  hasCapability,
  renderCapabilityManifest,
  workaroundApplies,
} from "../../../src/_internal/support/capabilities.js";
import { MINIMUM_TMUX } from "../../../src/_internal/support/versions.js";
import * as errors from "../../../src/errors.js";
import { readApiSurface } from "../../api_surface/api_surface.js";
import { MANIFEST_PATH } from "../emit-capabilities.js";

const version = parseTmuxVersion;

describe("support.capabilities", () => {
  test("the committed manifest is the registry", async () => {
    expect(await readFile(MANIFEST_PATH, "utf8")).toBe(renderCapabilityManifest());
  });

  test("names the floor the package enforces", () => {
    expect(capabilityManifest().floor.minimum).toBe(MINIMUM_TMUX);
  });

  test("keeps ids unique and kebab-case", () => {
    const ids = [...CAPABILITIES, ...WORKAROUNDS].map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
  });

  test("a refusing capability names its error", () => {
    for (const record of CAPABILITIES) {
      if (record.handling === "refuse") expect(record.error).toBeDefined();
    }
  });

  test("every API name resolves to a public symbol", async () => {
    const surface = await readApiSurface();
    const resolves = (name: string): boolean => {
      const [module, owner, member] = name.split(".");
      if (module === "errors") return owner !== undefined && owner in errors;
      return surface.some(
        (declared) =>
          declared.file === `src/${module}.ts` &&
          declared.name.toLowerCase() === owner?.toLowerCase() &&
          declared.members.some((entry) => entry.name === member),
      );
    };
    const named = [...CAPABILITIES, ...WORKAROUNDS].flatMap((record) =>
      "error" in record && record.error !== undefined
        ? record.apis.concat(record.error)
        : record.apis,
    );
    expect(named.filter((name) => !resolves(name))).toEqual([]);
  });

  test("reads capability and workaround releases from the table", () => {
    expect(hasCapability("buffer-rename", version("3.3a"))).toBe(false);
    expect(hasCapability("buffer-rename", version("3.4"))).toBe(true);
    expect(hasCapability("layout-json", version("3.7c"))).toBe(false);
    expect(hasCapability("layout-json", version("3.8"))).toBe(true);
    expect(workaroundApplies("break-pane-misnames-windows", version("3.7"))).toBe(true);
    expect(workaroundApplies("break-pane-misnames-windows", version("3.7a"))).toBe(false);
    expect(workaroundApplies("split-window-percent-size", version("3.4"))).toBe(true);
    expect(workaroundApplies("split-window-percent-size", version("3.5"))).toBe(false);
  });

  test("run-shell output is refused below the release that fixes it", () => {
    for (const raw of ["3.3a", "3.4", "next-3.5"]) {
      expect(workaroundApplies("run-shell-output-in-copy-mode", version(raw))).toBe(true);
    }
    for (const raw of ["3.5", "3.7", "3.8"]) {
      expect(workaroundApplies("run-shell-output-in-copy-mode", version(raw))).toBe(false);
    }
  });
});
